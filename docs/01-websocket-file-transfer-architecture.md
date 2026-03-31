# WebSocket 기반 실시간 파일 전송 아키텍처 설계

## 목차

1. [들어가며](#들어가며)
2. [왜 WebSocket인가](#왜-websocket인가)
3. [전체 아키텍처](#전체-아키텍처)
4. [프로토콜 설계](#프로토콜-설계)
5. [서버 핸들러 구조](#서버-핸들러-구조)
6. [바이너리 라우팅: fileTransferMap](#바이너리-라우팅-filetransfermap)
7. [스레드 안전 설계](#스레드-안전-설계)
8. [클라이언트 메시지 처리](#클라이언트-메시지-처리)
9. [마치며](#마치며)

---

## 들어가며

Netdrops는 브라우저만 열면 디바이스 제약 없이 파일을 주고받을 수 있는 서비스입니다.

이 글에서는 "브라우저 두 개 사이에서 파일을 실시간으로 전달한다"는 단순한 요구사항을 어떤 아키텍처로 풀어냈는지, 그리고 그 과정에서 내린 기술적 결정들을 다룹니다.

---

## 왜 WebSocket인가

파일 전송을 구현하는 방법은 여러 가지가 있습니다.

| 방식 | 장점 | 단점 |
|------|------|------|
| HTTP 업로드/다운로드 | 구현이 단순 | 서버에 파일 저장 필요, 실시간성 부족 |
| WebRTC (P2P) | 서버 부하 없음 | NAT/방화벽 이슈, STUN/TURN 서버 필요 |
| **WebSocket** | **실시간 양방향, 서버 제어 가능** | **서버가 릴레이 역할** |

우리가 WebSocket을 선택한 이유는 명확합니다.

**첫째, 서버에 파일을 저장하지 않겠다는 원칙.**
HTTP 방식은 송신자가 서버에 업로드하고, 수신자가 서버에서 다운로드하는 2단계를 거칩니다. 파일이 서버 디스크에 남게 되고, 이는 보안과 스토리지 비용 문제로 이어집니다. WebSocket은 송신자의 바이너리 데이터를 서버 메모리에서 즉시 수신자에게 전달(릴레이)할 수 있습니다.

**둘째, 실시간 사용자 탐색이 필요했다.**
"지금 접속 중인 사용자"를 실시간으로 보여주려면 서버 → 클라이언트 방향의 푸시가 필수입니다. HTTP 폴링으로도 가능하지만, 어차피 파일 전송에 양방향 채널이 필요하므로 WebSocket 하나로 통일하는 것이 합리적이었습니다.

**셋째, WebRTC보다 안정적인 연결.**
WebRTC는 P2P로 서버 부하가 없지만, NAT 환경에서 연결 실패율이 높고 STUN/TURN 서버를 별도로 운영해야 합니다. Netdrops는 Raspberry Pi 한 대로 운영하는 프로젝트이기 때문에 인프라를 최소화하면서도 안정적으로 동작하는 WebSocket 릴레이 방식이 적합했습니다.

---

## 전체 아키텍처

```
┌─────────────┐          ┌─────────┐          ┌──────────────┐
│   Desktop   │◄── WSS ──►│  Nginx  │◄── WSS ──►│    Mobile    │
│   Browser   │          │         │          │    Browser   │
└─────────────┘          └────┬────┘          └──────────────┘
                              │
                    ┌─────────┴─────────┐
                    │                   │
               /ws  │              /    │
                    ▼                   ▼
            ┌──────────────┐   ┌──────────────┐
            │ Spring Boot  │   │    React     │
            │  (Port 8080) │   │  (Port 3000) │
            │              │   │              │
            │ WebSocket    │   │  Nginx에서   │
            │ Handler      │   │  정적 파일   │
            │              │   │  서빙        │
            └──────────────┘   └──────────────┘
```

Nginx가 리버스 프록시 역할을 합니다.

- `/ws` 경로 → Spring Boot WebSocket 서버로 프록시
- `/` 경로 → React 프론트엔드(Nginx 컨테이너)로 프록시

클라이언트는 `wss://netdrops.cloud/ws`로 WebSocket 연결을 맺고, 이후 모든 통신(사용자 탐색, 전송 요청, 파일 전달)이 이 하나의 연결 위에서 이루어집니다.

---

## 프로토콜 설계

WebSocket은 텍스트 프레임과 바이너리 프레임을 구분합니다. 이 특성을 활용해 **제어 메시지는 JSON 텍스트**, **파일 데이터는 바이너리**로 분리했습니다.

### 메시지 타입 정의

| 타입 | 방향 | 프레임 | 역할 |
|------|------|--------|------|
| `init` | Server → Client | Text | 접속 시 세션 ID와 닉네임 부여 |
| `userList` | Server → All | Text | 접속자 목록 브로드캐스트 |
| `request` | Client → Server → Client | Text | 파일 전송 요청 |
| `response` | Client → Server → Client | Text | 전송 요청 수락/거절 |
| `meta` | Client → Server → Client | Text | 전송할 파일의 메타데이터 (이름, MIME 타입) |
| *(binary)* | Client → Server → Client | Binary | 실제 파일 데이터 |
| `complete` | Client → Server → Client | Text | 전송 완료 신호 |

### 전체 시퀀스

```
 송신자(A)              서버                수신자(B)
    │                    │                    │
    │── request ────────►│── request ────────►│
    │                    │                    │
    │◄── response ───────│◄── response ───────│  (수락)
    │                    │                    │
    │   [파일 선택]       │  fileTransferMap   │
    │                    │   [A] = B          │
    │                    │                    │
    │── meta ───────────►│── meta ───────────►│  pendingMeta 저장
    │── binary ─────────►│── binary ─────────►│  Blob 생성 → 저장 바 표시
    │── complete ───────►│── complete ───────►│
    │                    │                    │
    │                    │  fileTransferMap   │
    │                    │   [A] 제거         │
```

### 왜 meta → binary → complete 3단계인가

단순히 바이너리 데이터만 보내면 수신자는 파일 이름과 타입을 알 수 없습니다. HTTP처럼 헤더를 붙일 수 없는 WebSocket의 특성상, 메타데이터를 별도 메시지로 먼저 보내야 합니다.

```javascript
// 송신자 (클라이언트)
// 1. 파일 정보를 JSON으로 먼저 전송
ws.send(JSON.stringify({
    type: "meta",
    fileName: "photo.jpg",
    fileType: "image/jpeg",
    target: targetSessionId,
}));

// 2. 파일 바이너리 전송
const arrayBuffer = await file.arrayBuffer();
ws.send(arrayBuffer);

// 3. 전송 완료 신호
ws.send(JSON.stringify({
    type: "complete",
    target: targetSessionId,
}));
```

```javascript
// 수신자 (클라이언트)
ws.onmessage = (event) => {
    if (typeof event.data === "string") {
        const data = JSON.parse(event.data);
        if (data.type === "meta") {
            // 다음에 올 바이너리의 메타데이터를 저장
            pendingMeta.current = {
                fileName: data.fileName,
                fileType: data.fileType,
            };
        }
    } else {
        // 바이너리 수신 → 직전 meta와 매핑하여 파일 생성
        const meta = pendingMeta.current;
        const blob = new Blob([event.data], { type: meta.fileType });
        setReceivedFile({ name: meta.fileName, blob });
        pendingMeta.current = null;
    }
};
```

WebSocket은 **메시지 순서를 보장**하므로, meta가 반드시 binary보다 먼저 도착합니다. `complete`는 서버 측에서 `fileTransferMap` 매핑을 해제하는 트리거 역할을 합니다.

---

## 서버 핸들러 구조

서버의 핵심은 `MainSocketHandler`입니다. Spring의 `BinaryWebSocketHandler`를 상속하여 텍스트와 바이너리 메시지를 모두 처리합니다.

### 세션 관리

```java
public class MainSocketHandler extends BinaryWebSocketHandler {

    // 모든 접속자의 세션 정보
    private final Map<String, UserSession> sessions = new ConcurrentHashMap<>();

    // 파일 전송 매핑: 송신자 sessionId → 수신자 sessionId
    private final Map<String, String> fileTransferMap = new ConcurrentHashMap<>();

    // 세션별 전송 락
    private final Map<String, Object> sessionLocks = new ConcurrentHashMap<>();
}
```

세 개의 `ConcurrentHashMap`이 서버의 상태를 구성합니다.

- `sessions`: 현재 접속 중인 모든 사용자. 접속 시 추가, 종료 시 제거.
- `fileTransferMap`: 현재 진행 중인 파일 전송의 송신자→수신자 매핑.
- `sessionLocks`: WebSocket 세션에 동시에 메시지를 보내는 것을 방지하는 락 객체.

### 연결 수립

```java
@Override
public void afterConnectionEstablished(WebSocketSession session) {
    // 세션 레벨에서 바이너리 메시지 크기 제한 설정
    session.setBinaryMessageSizeLimit(100 * 1024 * 1024); // 100MB
    session.setTextMessageSizeLimit(64 * 1024);            // 64KB

    // 닉네임 생성 및 세션 등록
    String nickname = NicknameGenerator.generate();
    sessions.put(session.getId(), new UserSession(session.getId(), nickname, session));

    // 접속한 클라이언트에게 자신의 정보 전달
    sendSafe(session, new TextMessage(
        objectMapper.writeValueAsString(
            Map.of("type", "init", "sessionId", session.getId(), "nickname", nickname)
        )
    ));

    // 전체 사용자 목록 브로드캐스트
    broadcastUserList();
}
```

`setBinaryMessageSizeLimit`을 세션 레벨에서 명시적으로 설정하는 이유는 뒤에서 다룰 [바이너리 릴레이 트러블슈팅](./02-websocket-binary-1002-error.md)에서 자세히 설명합니다.

### 텍스트 메시지 라우팅

모든 텍스트 메시지는 `type` 필드를 기준으로 분기합니다.

```java
@Override
protected void handleTextMessage(WebSocketSession session, TextMessage message) {
    JsonNode json = objectMapper.readTree(message.getPayload());
    String type = json.get("type").asText();

    switch (type) {
        case "request":  // 전송 요청 → 대상에게 전달
        case "meta":     // 파일 메타데이터 → 대상에게 전달
        case "complete": // 전송 완료 → 대상에게 전달 + 매핑 해제
            forwardToTarget(json, message, session);
            break;

        case "response": // 수락/거절 → 요청자에게 전달 + 매핑 생성
            handleResponse(json, message, session);
            break;
    }
}
```

`request`, `meta`, `complete`는 단순 포워딩이고, `response`만 특별한 처리(fileTransferMap 매핑 생성)가 추가됩니다.

---

## 바이너리 라우팅: fileTransferMap

파일 전송에서 가장 핵심적인 설계 포인트입니다.

### 문제

텍스트 메시지는 JSON 안에 `target` 필드가 있어서 "누구에게 보낼지"를 메시지 자체에서 알 수 있습니다. 하지만 **바이너리 메시지에는 헤더가 없습니다.** 순수한 파일 데이터(ArrayBuffer)만 들어있으므로, 서버는 이 바이너리를 누구에게 전달해야 하는지 알 수 없습니다.

### 해결: fileTransferMap

수신자가 전송을 수락하는 시점에 **송신자 → 수신자 매핑**을 미리 등록해둡니다.

```java
case "response": {
    boolean accepted = json.get("data").get("accepted").asBoolean();
    String senderId = json.get("target").asText();  // 원래 요청자

    if (accepted) {
        // 핵심: 송신자 → 수신자 매핑 등록
        fileTransferMap.put(senderId, session.getId());
    }
    break;
}
```

이후 바이너리가 도착하면, **보낸 사람의 sessionId**만으로 수신자를 찾을 수 있습니다.

```java
@Override
protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
    String senderId = session.getId();

    // 매핑에서 수신자 조회
    String targetId = fileTransferMap.get(senderId);

    if (targetId != null) {
        UserSession target = sessions.get(targetId);
        if (target != null && target.getSession().isOpen()) {
            // 바이너리 데이터 복사 후 전달
            byte[] data = new byte[message.getPayloadLength()];
            message.getPayload().get(data);
            sendSafe(target.getSession(), new BinaryMessage(data));
        }
    }
}
```

### 매핑의 생명주기

```
수락(response accepted) → fileTransferMap[A] = B   (생성)
전송 완료(complete)      → fileTransferMap[A] 제거  (해제)
연결 종료(close)         → fileTransferMap[A] 제거  (정리)
```

`complete` 메시지가 도착하거나 연결이 끊어지면 매핑을 반드시 제거합니다. 이렇게 하지 않으면 이후 같은 세션에서 다른 사용자에게 파일을 보낼 때 이전 매핑이 남아 엉뚱한 사람에게 파일이 전달될 수 있습니다.

---

## 스레드 안전 설계

WebSocket 핸들러는 Tomcat의 I/O 스레드 풀에서 동시에 호출됩니다. 두 클라이언트가 거의 같은 시점에 메시지를 보내면 여러 스레드가 동시에 핸들러 메서드를 실행합니다.

### 문제 1: 동시 세션 접근

일반 `HashMap`을 사용하면 두 스레드가 동시에 `put()`을 호출할 때 내부 구조가 손상될 수 있습니다.

**해결: ConcurrentHashMap**

```java
private final Map<String, UserSession> sessions = new ConcurrentHashMap<>();
private final Map<String, String> fileTransferMap = new ConcurrentHashMap<>();
```

`ConcurrentHashMap`은 내부적으로 세그먼트 락을 사용하여 여러 스레드가 동시에 `get()`, `put()`, `remove()`해도 안전합니다. 순회 중에도 구조 변경이 가능하여 `ConcurrentModificationException`이 발생하지 않습니다.

### 문제 2: WebSocket 동시 전송

Tomcat의 `WebSocketSession`은 **동시에 두 개의 메시지를 보내면 안 됩니다.** 예를 들어 한 스레드가 유저 리스트를 브로드캐스트하는 중에 다른 스레드가 같은 세션에 파일 데이터를 보내면 프레임이 섞여 프로토콜 에러가 발생합니다.

**해결: 세션별 락**

```java
private final Map<String, Object> sessionLocks = new ConcurrentHashMap<>();

private void sendSafe(WebSocketSession session, WebSocketMessage<?> message) {
    // 세션 ID별로 고유한 락 객체를 생성/조회
    Object lock = sessionLocks.computeIfAbsent(session.getId(), k -> new Object());

    synchronized (lock) {
        try {
            if (session.isOpen()) {
                session.sendMessage(message);
            }
        } catch (Exception e) {
            logger.error("Error sending to {}: {}", session.getId(), e.getMessage(), e);
        }
    }
}
```

`computeIfAbsent`는 원자적으로 동작하므로, 같은 세션 ID에 대해 반드시 하나의 락 객체만 생성됩니다. 이 락으로 동일 세션에 대한 메시지 전송을 직렬화합니다.

**왜 글로벌 락이 아닌 세션별 락인가?**

글로벌 락(`synchronized(this)`)을 사용하면 A에게 보내는 동안 B에게도 보낼 수 없게 됩니다. 세션별 락을 사용하면 A에게 보내는 것과 B에게 보내는 것은 서로 간섭하지 않아 처리량이 크게 향상됩니다.

### 연결 종료 시 정리

```java
@Override
public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
    sessions.remove(session.getId());
    fileTransferMap.remove(session.getId());
    sessionLocks.remove(session.getId());  // 락 객체도 정리
    broadcastUserList();
}
```

연결이 종료되면 세 개의 Map에서 모두 해당 세션을 제거합니다. `sessionLocks`까지 정리하지 않으면 접속/종료가 반복될 때 메모리 누수가 발생할 수 있습니다.

---

## 클라이언트 메시지 처리

클라이언트(React)는 단일 WebSocket 연결로 모든 통신을 처리합니다.

### 연결 설정

```javascript
const ws = useRef(null);
const pendingMeta = useRef(null);

useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws.current = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.current.binaryType = "arraybuffer";  // 바이너리를 ArrayBuffer로 수신
    // ...
}, []);
```

`binaryType = "arraybuffer"`를 설정하여 바이너리 메시지를 `ArrayBuffer`로 받습니다. 기본값인 `Blob`이 아닌 `ArrayBuffer`를 사용하는 이유는 `typeof` 체크로 텍스트/바이너리를 쉽게 구분할 수 있고, `Blob` 생성 시 타입을 명시적으로 지정할 수 있기 때문입니다.

### 메시지 분기

```javascript
ws.current.onmessage = (event) => {
    if (typeof event.data === "string") {
        // JSON 텍스트 메시지 → type별 분기
        const data = JSON.parse(event.data);
        switch (data.type) {
            case "init":     // 내 정보 저장
            case "userList": // 유저 목록 갱신
            case "request":  // 전송 요청 모달 표시
            case "response": // 수락 → 파일 선택, 거절 → 초기화
            case "meta":     // pendingMeta에 파일 정보 저장
            case "complete": // 로그
        }
    } else {
        // 바이너리 → pendingMeta와 결합하여 파일 생성
        const blob = new Blob([event.data], { type: pendingMeta.current.fileType });
        setReceivedFile({ name: pendingMeta.current.fileName, blob });
        pendingMeta.current = null;
    }
};
```

`pendingMeta`를 `useRef`로 관리하는 이유는 WebSocket 이벤트 핸들러가 클로저로 캡처되기 때문입니다. `useState`를 사용하면 핸들러 내부에서 항상 초기값을 참조하게 되지만, `useRef`는 항상 최신 값을 참조합니다.

---

## 마치며

Netdrops의 아키텍처는 단순합니다. WebSocket 하나로 연결하고, JSON으로 제어하고, 바이너리로 파일을 보냅니다.

하지만 이 단순한 구조 안에서도 고려해야 할 것들이 있었습니다.

- 바이너리에는 헤더가 없으므로 `fileTransferMap`으로 라우팅 경로를 미리 등록
- WebSocket 세션은 동시 전송이 불가하므로 세션별 락으로 직렬화
- `ConcurrentHashMap`으로 다중 스레드 환경에서의 안전성 확보
- 연결 종료 시 모든 상태를 정리하여 메모리 누수 방지

다음 글에서는 이 아키텍처 위에서 실제로 발생한 [바이너리 릴레이 시 1002 Protocol Error](./02-websocket-binary-1002-error.md)를 다루겠습니다.
