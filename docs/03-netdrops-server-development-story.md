# AirDrop이 안 되길래, 직접 만들었다 — NetDrops 서버 개발기

## 목차

1. [AirDrop이 안 되는 세상](#1-airdrop이-안-되는-세상)
2. [기술 선택: 왜 WebSocket인가](#2-기술-선택-왜-websocket인가)
3. [서버 아키텍처 설계](#3-서버-아키텍처-설계)
4. [WebSocket 연결 Lifecycle 구현](#4-websocket-연결-lifecycle-구현)
5. [Broadcast 설계](#5-broadcast-설계)
6. [동시성 처리: Per-Session Lock](#6-동시성-처리-per-session-lock)
7. [마무리 & 향후 계획](#7-마무리--향후-계획)

---

## 1. AirDrop이 안 되는 세상

iPad에서 찍은 사진을 Windows 노트북으로 옮기고 싶었습니다.

AirDrop? Apple 기기끼리만 됩니다. 카카오톡? 화질이 압축됩니다. USB? 케이블이 없습니다. 클라우드? 업로드하고, 로그인하고, 다운로드하고 — 파일 하나 보내는 데 3단계입니다.

같은 Wi-Fi에 연결되어 있는데, 브라우저 하나 열면 바로 파일을 주고받을 수는 없을까?

이 질문에서 NetDrops가 시작됐습니다. 목표는 단순했습니다.

- **설치 없이** 브라우저만으로 동작할 것
- **디바이스 제약 없이** Windows, Mac, iOS, Android 모두 지원할 것
- **서버에 파일을 저장하지 않을 것** — 실시간으로 릴레이만 할 것

---

## 2. 기술 선택: 왜 WebSocket인가

브라우저 간 파일 전송을 구현하는 방법은 크게 세 가지입니다.

| 방식 | 장점 | 단점 |
|------|------|------|
| HTTP Upload/Download | 구현이 단순 | 서버에 파일 저장 필요, 실시간성 부족 |
| WebRTC (P2P) | 서버 부하 없음 | NAT/방화벽 이슈, STUN/TURN 서버 필요 |
| **WebSocket Relay** | **실시간 양방향, 서버 제어 가능** | **서버가 릴레이 역할 — 메모리 경유** |

### HTTP — 파일이 서버에 남는 문제

HTTP 방식은 송신자가 서버에 업로드하고, 수신자가 서버에서 다운로드하는 2단계를 거칩니다. 파일이 서버 디스크에 남게 되고, 이는 보안과 스토리지 비용 문제로 이어집니다. "서버에 파일을 저장하지 않는다"는 원칙과 맞지 않았습니다.

### WebRTC — 매력적이지만 현실적이지 않았던 선택

P2P라 서버 부하가 없다는 점은 매력적이었습니다. 하지만 NAT 환경에서 연결 실패율이 높고, STUN/TURN 서버를 별도로 운영해야 합니다. NetDrops는 **Raspberry Pi 한 대**로 운영하는 프로젝트입니다. 인프라를 최소화하면서도 안정적으로 동작해야 했고, WebRTC의 복잡도는 이 목표와 맞지 않았습니다.

### WebSocket — 트레이드오프를 받아들인 선택

WebSocket Relay는 모든 파일 데이터가 서버 메모리를 경유합니다. 서버에 부하가 생기는 것은 분명한 단점입니다.

하지만 우리 상황에서 이 트레이드오프는 수용 가능했습니다.

- 릴레이는 메모리 복사일 뿐, CPU 연산이 거의 없음
- 같은 네트워크 내 파일 공유라 대규모 트래픽이 발생하지 않음
- 핸들러 코드 169줄로 전체 로직 구현 가능 — WebRTC 대비 복잡도 1/10
- 기업 방화벽 뒤에서도 HTTP Upgrade 기반의 WebSocket은 대부분 동작

추가로, WebSocket을 선택하면 파일 전송뿐 아니라 **실시간 사용자 탐색**(접속자 목록 broadcast)까지 하나의 연결로 처리할 수 있었습니다. 어차피 양방향 채널이 필요한 상황에서, WebSocket 하나로 통일하는 것이 가장 합리적이었습니다.

---

## 3. 서버 아키텍처 설계

### 전체 구조

```
 송신자(A)                    서버                     수신자(B)
    │                          │                          │
    │──── request ────────────►│──── request ────────────►│
    │                          │                          │
    │◄──── response ───────────│◄──── response ───────────│  (수락)
    │                          │                          │
    │                    fileTransferMap                   │
    │                      [A] = B                        │
    │                          │                          │
    │──── meta ───────────────►│──── meta ───────────────►│
    │──── binary ─────────────►│──── binary (copy) ──────►│
    │──── complete ───────────►│──── complete ───────────►│
    │                          │                          │
    │                    fileTransferMap                   │
    │                      [A] 제거                       │
```

서버는 파일을 저장하지 않습니다. 송신자로부터 받은 바이너리 데이터를 메모리에서 복사해 수신자에게 즉시 전달하고, 전송이 끝나면 모든 상태를 정리합니다.

### 핵심 자료구조 — ConcurrentHashMap 3개

서버의 전체 상태는 세 개의 Map으로 구성됩니다.

```java
public class MainSocketHandler extends BinaryWebSocketHandler {

    // 접속 중인 모든 유저의 세션 정보
    private final Map<String, UserSession> sessions = new ConcurrentHashMap<>();

    // 파일 전송 라우팅: 송신자 sessionId → 수신자 sessionId
    private final Map<String, String> fileTransferMap = new ConcurrentHashMap<>();

    // 세션별 메시지 전송 락
    private final Map<String, Object> sessionLocks = new ConcurrentHashMap<>();
}
```

각각의 역할이 명확합니다.

- `sessions` — "지금 누가 접속해 있는가"
- `fileTransferMap` — "이 바이너리를 누구에게 보낼 것인가"
- `sessionLocks` — "같은 세션에 동시에 쓰지 않도록"

### 왜 DB 없이 In-Memory인가

DB를 두면 세션 영속성, 전송 이력, 수평 확장 등 많은 것을 얻을 수 있습니다. 하지만 그 대가로 잃는 것도 있습니다.

| | In-Memory (ConcurrentHashMap) | DB (Redis, RDB 등) |
|---|---|---|
| 조회 속도 | 마이크로초 | 밀리초 |
| 배포 복잡도 | JVM 하나 | DB 서버 운영 필요 |
| 장애 복구 | 재시작 시 세션 유실 | 복구 가능 |
| 확장성 | 단일 노드 한정 | 수평 확장 가능 |

NetDrops의 사용 패턴은 "같은 공간에서 잠깐 파일 주고받기"입니다. 세션이 유실되면 브라우저를 새로고침하면 됩니다. 이 상황에서 DB 운영 비용은 과한 선택이었고, Raspberry Pi 단일 노드 배포라는 제약 조건에서 In-Memory가 가장 합리적이었습니다.

---

## 4. WebSocket 연결 Lifecycle 구현

### Connect — 닉네임 부여와 유저 목록 갱신

새 클라이언트가 접속하면 세 가지 일이 순서대로 일어납니다.

```java
@Override
public void afterConnectionEstablished(WebSocketSession session) {
    // 1. 버퍼 크기 설정
    session.setBinaryMessageSizeLimit(100 * 1024 * 1024); // 100MB
    session.setTextMessageSizeLimit(64 * 1024);            // 64KB

    // 2. 닉네임 생성 → 세션 등록
    String nickname = NicknameGenerator.generate();
    sessions.put(session.getId(), new UserSession(session.getId(), nickname, session));

    // 3. 본인에게 init 메시지 → 전체에게 유저 목록 broadcast
    sendSafe(session, new TextMessage(
        objectMapper.writeValueAsString(
            Map.of("type", "init", "sessionId", session.getId(), "nickname", nickname)
        )
    ));
    broadcastUserList();
}
```

`setBinaryMessageSizeLimit`을 세션 레벨에서 명시적으로 재설정하는 이유가 있습니다. WebSocket 컨테이너 설정(`WebSocketConfig`)에서 100MB로 지정해도, 실제 세션에는 Tomcat의 기본값(65KB)이 적용되는 경우가 있었습니다. 컨테이너 설정을 믿지 않고 세션마다 직접 지정하는 것이 방어적으로 안전합니다.

### Message — Text와 Binary의 분리

WebSocket은 텍스트 프레임과 바이너리 프레임을 네이티브로 구분합니다. 이 특성을 활용해 **제어 메시지는 JSON 텍스트**, **파일 데이터는 바이너리**로 분리했습니다.

텍스트 메시지는 `type` 필드로 라우팅합니다.

```java
@Override
protected void handleTextMessage(WebSocketSession session, TextMessage message) {
    JsonNode json = objectMapper.readTree(message.getPayload());
    String type = json.get("type").asText();

    switch (type) {
        case "request":                          // 전송 요청 → 대상에게 포워딩
            forwardToTarget(json, message);
            break;
        case "response":                         // 수락/거절 → 요청자에게 + 매핑 생성
            handleResponse(json, message, session);
            break;
        case "meta":                             // 파일 메타데이터 → 대상에게 포워딩
            forwardToTarget(json, message);
            break;
        case "complete":                         // 전송 완료 → 대상에게 + 매핑 해제
            forwardToTarget(json, message);
            fileTransferMap.remove(session.getId());
            break;
    }
}
```

바이너리 메시지에는 헤더가 없습니다. "누구에게 보낼지"를 메시지 자체에서 알 수 없으므로, 사전에 등록해둔 `fileTransferMap`에서 수신자를 조회합니다.

```java
@Override
protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
    String senderId = session.getId();
    String targetId = fileTransferMap.get(senderId);

    if (targetId != null) {
        UserSession target = sessions.get(targetId);
        if (target != null && target.getSession().isOpen()) {
            byte[] data = new byte[message.getPayloadLength()];
            message.getPayload().get(data);
            sendSafe(target.getSession(), new BinaryMessage(data));
        }
    }
}
```

여기서 `message.getPayload()`를 직접 전달하지 않고 **새 byte 배열로 복사**하는 부분이 중요합니다. Tomcat은 내부적으로 ByteBuffer를 재사용(pooling)합니다. 핸들러가 리턴된 후 원본 버퍼가 회수되면 수신자에게 전달 중인 데이터가 덮어씌워질 수 있습니다. 이 문제로 실제 운영 중 1002 Protocol Error가 발생했고, byte 배열 복사로 해결했습니다. (자세한 내용은 [바이너리 릴레이 트러블슈팅](./02-websocket-binary-1002-error.md)에서 다룹니다.)

### Disconnect — 상태 정리

```java
@Override
public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
    sessions.remove(session.getId());
    fileTransferMap.remove(session.getId());
    sessionLocks.remove(session.getId());
    broadcastUserList();
}
```

세 개의 Map에서 모두 해당 세션을 제거합니다. `sessionLocks`까지 정리하지 않으면 접속/종료가 반복될 때 **메모리 누수**가 발생합니다. 사소해 보이지만 장시간 운영되는 서버에서는 치명적입니다.

---

## 5. Broadcast 설계

NetDrops의 메시지 전달 방식은 두 가지로 나뉩니다. **전체 broadcast**와 **1:1 선택적 라우팅**입니다.

### 전체 Broadcast — 유저 목록

유저가 접속하거나 떠날 때, 모든 클라이언트가 최신 접속자 목록을 알아야 합니다.

```java
private void broadcastUserList() {
    List<Map<String, String>> userList = sessions.values().stream()
            .map(u -> Map.of("sessionId", u.getSessionId(), "nickname", u.getNickname()))
            .collect(Collectors.toList());

    String json = objectMapper.writeValueAsString(
        Map.of("type", "userList", "users", userList)
    );
    TextMessage msg = new TextMessage(json);

    sessions.values().forEach(user -> sendSafe(user.getSession(), msg));
}
```

`TextMessage` 객체를 한 번만 생성하고 모든 세션에 재사용합니다. 접속자가 100명이면 JSON 직렬화는 1번, 전송은 100번입니다.

### 1:1 선택적 라우팅 — 파일 전송

파일 전송 관련 메시지(`request`, `response`, `meta`, `binary`, `complete`)는 특정 대상에게만 전달합니다.

| 메시지 타입 | 전달 방식 | 라우팅 기준 |
|---|---|---|
| `userList` | **Broadcast** (전체) | 모든 세션 순회 |
| `request` / `meta` / `complete` | **1:1** | JSON의 `target` 필드 |
| `response` | **1:1** | JSON의 `target` 필드 (원래 요청자) |
| `binary` | **1:1** | `fileTransferMap` 조회 |

왜 파일 전송을 broadcast하지 않았을까요? 당연한 것 같지만, 설계 시점에서 "그룹 전송(한 명이 여러 명에게)"을 지원할지 고민했습니다. 그룹 전송을 하려면 broadcast 방식이 필요합니다. 하지만 100MB 파일을 N명에게 동시에 릴레이하면 서버 메모리 사용량이 `100MB x N`이 됩니다. Raspberry Pi의 제한된 메모리에서 이는 치명적입니다.

**1:1 전송만 지원하는 것은 의도된 제약**입니다. 이 제약 덕분에 서버는 항상 하나의 파일 데이터만 메모리에 들고 있으면 되고, 메모리 사용량을 예측 가능한 범위 안에서 유지할 수 있습니다.

### fileTransferMap — 바이너리 라우팅의 핵심

텍스트 메시지는 JSON 안에 `target` 필드가 있어 라우팅이 자명합니다. 하지만 바이너리 메시지는 순수한 파일 데이터(ArrayBuffer)만 담고 있어, 서버가 "이걸 누구에게 보낼지" 알 수 없습니다.

이 문제를 해결하기 위해 수신자가 전송을 **수락하는 시점**에 매핑을 미리 등록합니다.

```java
case "response": {
    boolean accepted = json.get("data").get("accepted").asBoolean();
    String senderId = json.get("target").asText();

    if (accepted) {
        fileTransferMap.put(senderId, session.getId());
    }
    break;
}
```

이후 바이너리가 도착하면, **보낸 사람의 sessionId 하나만으로** 수신자를 찾을 수 있습니다. 전송이 끝나거나(`complete`) 연결이 끊어지면(`close`) 매핑을 제거하여 다음 전송에 영향을 주지 않도록 합니다.

---

## 6. 동시성 처리: Per-Session Lock

WebSocket 핸들러는 Tomcat의 I/O 스레드 풀에서 호출됩니다. 유저 A가 접속하는 동시에 유저 B가 파일을 보내면, 두 스레드가 동시에 핸들러를 실행합니다.

### 문제: WebSocketSession은 Thread-Safe하지 않다

Tomcat의 `WebSocketSession.sendMessage()`는 **동시 호출을 허용하지 않습니다.** 한 스레드가 유저 C에게 유저 목록을 broadcast하는 중에 다른 스레드가 유저 C에게 바이너리를 보내면, WebSocket 프레임이 섞여 프로토콜 에러가 발생합니다.

### 해결: 세션별 락

```java
private void sendSafe(WebSocketSession session, WebSocketMessage<?> message) {
    Object lock = sessionLocks.computeIfAbsent(session.getId(), k -> new Object());
    synchronized (lock) {
        if (session.isOpen()) {
            session.sendMessage(message);
        }
    }
}
```

모든 메시지 전송은 반드시 `sendSafe()`를 통합니다. 같은 세션 ID에 대해 `computeIfAbsent`가 원자적으로 하나의 락 객체만 생성하고, `synchronized` 블록으로 해당 세션에 대한 전송을 직렬화합니다.

### 왜 Global Lock이 아닌가

가장 쉬운 방법은 `synchronized(this)`로 전체를 잠그는 것입니다.

```
Global Lock:
  Thread 1 → send(A) ██████████
  Thread 2 → send(B)           ██████████  ← A 전송이 끝나야 B에게 보낼 수 있음

Per-Session Lock:
  Thread 1 → send(A) ██████████
  Thread 2 → send(B) ██████████  ← A와 B는 서로 다른 락이므로 동시 전송 가능
```

Global Lock은 A에게 보내는 동안 B에게도 보낼 수 없습니다. 유저 수가 늘어날수록 병목이 심해집니다. Per-Session Lock은 **같은 세션에 대한 전송만 직렬화**하고, 서로 다른 세션 간에는 완전한 병렬 처리가 가능합니다.

락 객체가 하나 더 필요하다는 메모리 오버헤드가 있지만, 유저당 Object 하나(16바이트)입니다. 100명이 접속해도 1.6KB. 이 트레이드오프는 받아들일 만합니다.

---

## 7. 마무리 & 향후 계획

NetDrops 서버의 핵심 로직은 **169줄**입니다. ConcurrentHashMap 3개, sendSafe 메서드 1개, 메시지 타입별 switch 문 하나로 실시간 파일 전송 서버가 동작합니다.

이 단순함은 의도된 결과입니다. 모든 설계 결정에서 **"우리 상황에서 정말 필요한가"** 를 기준으로 판단했습니다.

- DB 대신 In-Memory → 조회 속도와 배포 단순성 확보
- WebRTC 대신 WebSocket Relay → 인프라 최소화와 안정성 확보
- 그룹 전송 대신 1:1 → 메모리 사용량 예측 가능성 확보
- Global Lock 대신 Per-Session Lock → 동시 처리 성능 확보

물론 이 선택들에는 명확한 한계가 있습니다.

### 남은 과제

- **대용량 파일 지원**: 현재 100MB 제한은 서버 메모리 보호를 위한 것입니다. 청크 단위 전송을 구현하면 메모리를 고정 크기로 유지하면서 큰 파일도 처리할 수 있습니다.
- **수평 확장**: 단일 JVM의 ConcurrentHashMap은 수평 확장이 불가능합니다. 유저가 늘어나면 Redis Pub/Sub이나 메시지 브로커를 도입해 서버 간 세션을 공유해야 합니다.
- **전송 재개**: 연결이 끊어지면 처음부터 다시 보내야 합니다. 청크 전송과 결합하면 중단된 지점부터 이어보내기가 가능해집니다.

169줄로 시작했지만, 이 위에 얼마든지 쌓아올릴 수 있습니다. 트레이드오프를 인식하고 있다면, 그것은 한계가 아니라 **다음 단계의 출발점**입니다.
