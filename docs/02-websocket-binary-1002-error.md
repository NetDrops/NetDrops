# WebSocket 동시 전송 문제와 세션별 락 도입기

## 목차

1. [문제 상황](#문제-상황)
2. [원인 추적](#원인-추적)
3. [1002 Protocol Error: 프레임 인터리빙](#1002-protocol-error-프레임-인터리빙)
4. [해결 후보군](#해결-후보군)
5. [결론: Per-session synchronized](#결론-per-session-synchronized)
6. [적용과 검증](#적용과-검증)
7. [남은 과제](#남은-과제)
8. [마치며](#마치며)

---

## 문제 상황

[이전 글](./01-websocket-file-transfer-architecture.md)에서 설계한 Netdrops의 WebSocket 파일 전송 아키텍처를 배포한 후, A와 B 사이의 1:1 전송은 정상 동작했습니다.

그런데 **A가 B에게 파일을 전송하는 도중 C가 Netdrops에 접속하면, B의 WebSocket 연결이 끊어지는 현상**을 발견했습니다.

- 송신자 A: 전송 완료로 표시됨
- 수신자 B: 파일을 받지 못하고 **연결이 끊어짐**
- C가 접속하지 않으면: 정상 전송

제3자의 접속이 진행 중인 전송을 방해해서는 안 됩니다. 이 시나리오를 재현하고 원인을 추적했습니다.

---

## 원인 추적

### 서버 로그

"A→B 전송 중 C 접속" 시나리오를 재현하고 서버 로그를 확인했습니다.

```
INFO  Text from ec8f5976: type=meta
INFO  Binary: sender=ec8f5976, target=7d693674, size=423178
INFO  Text from ec8f5976: type=complete
INFO  Transfer complete, mapping removed: sender=ec8f5976
INFO  Disconnected: sessionId=7d693674, status=CloseStatus[code=1002, reason=null]
```

```
at org.apache.tomcat.websocket.WsRemoteEndpointImplBase.writeMessagePart(...)
at org.apache.tomcat.websocket.WsRemoteEndpointImplBase.sendMessageBlockInternal(...)
```

서버는 A로부터 바이너리를 정상 수신했고, B도 정상 조회했습니다. 하지만 B에게 릴레이하는 과정에서 **1002 Protocol Error**가 발생하며 B의 연결이 끊어졌습니다.

### 1002와 "C 접속 시에만 재현"을 결합하면

1002는 수신 측 브라우저가 **프로토콜 규격에 맞지 않는 프레임**을 받았을 때 발생합니다. C의 접속이 B의 소켓에 어떤 영향을 주는 코드 경로가 있다는 뜻입니다.

기존 코드를 다시 보니 답이 보였습니다:

```java
// broadcastUserList() — 모든 세션에 전송
sessions.values().forEach(user -> {
    user.getSession().sendMessage(new TextMessage(message));
});

// handleBinaryMessage() — 타겟에 전송
targetUser.getSession().sendMessage(message);
```

C가 접속하면 `afterConnectionEstablished()`에서 `broadcastUserList()`가 호출됩니다. 이때 **B의 세션에도** `sendMessage()`를 호출합니다. A가 B에게 바이너리를 전송하는 `sendMessage()`가 아직 진행 중인데, `broadcastUserList()`의 `sendMessage()`가 **동시에** B의 세션에 접근하는 것입니다.

`sendSafe`도 없고, `synchronized`도 없었습니다. 동기화가 전혀 없는 상태에서 두 스레드가 같은 세션에 동시에 쓰고 있었습니다.

### Tomcat의 스레드 모델

Tomcat은 NIO Selector + 스레드 풀로 WebSocket 연결을 관리합니다. **서로 다른 연결의 메시지는 서로 다른 I/O 스레드에서 동시에 처리됩니다.**

```
연결 A (송신자)  →  I/O 스레드 1  →  handleBinaryMessage()  →  B.session.sendMessage()
연결 C (신규)    →  I/O 스레드 2  →  afterConnectionEstablished()  →  broadcastUserList()  →  B.session.sendMessage()
```

같은 연결의 메시지는 순서대로 처리되지만, A의 I/O 스레드와 C의 I/O 스레드는 **동시에 B의 세션에 sendMessage()를 호출할 수 있습니다.**

JSR 356(Java WebSocket API) 스펙과 Spring 공식 문서는 이를 명시적으로 금지합니다:

> *"The application must synchronize the sending of messages since the underlying standard WebSocket session (JSR-356) does not allow concurrent sending."*

---

## 1002 Protocol Error: 프레임 인터리빙

동기화 없이 동시 전송이 일어나면 구체적으로 어떤 일이 벌어지는지 추적했습니다.

### sendMessage() 내부

`sendMessage()`는 단일 API 호출이지만, Tomcat 내부에서는 메시지를 여러 WebSocket 프레임으로 분할하여 전송합니다:

```java
// org.apache.tomcat.websocket.WsRemoteEndpointImplBase (간략화)

private void sendMessageBlock(byte opCode, ByteBuffer payload, boolean last)
        throws IOException {
    while (payload.hasRemaining()) {        // 메시지 크기에 따라 여러 번 반복
        outputBuffer.put(payload);           // payload에서 outputBuffer 크기만큼 복사
        if (!outputBuffer.hasRemaining()) {
            flush();                         // TCP 소켓으로 전송
        }
    }
}
```

이 while 루프가 도는 동안, 다른 스레드가 같은 세션에 `sendMessage()`를 호출하면 **프레임이 섞입니다**:

```
Thread 1 (A→B 바이너리 전송):
  B.session.sendMessage(binary)
  → Frame 1 [FIN=0, opcode=0x2] → Frame 2 [FIN=0, opcode=0x0] → ... 전송 중

Thread 2 (C 접속 → broadcastUserList):                 ← 동시 발생
  B.session.sendMessage(userList text)
  → Frame ? [FIN=1, opcode=0x1]                         ← 끼어듦!
```

### 브라우저가 받는 프레임 시퀀스

```
  Frame N:   [FIN=0, opcode=0x0, data=binary_chunk]    ← binary continuation
  Frame  ?:  [FIN=1, opcode=0x1, data=userList_json]    ← text 프레임이 끼어듦
  Frame N+1: [FIN=0, opcode=0x0, data=binary_chunk]    ← binary continuation 재개
```

RFC 6455 Section 5.4에 따르면, continuation 프레임 시퀀스 중간에 **데이터 프레임(text/binary)이 끼어드는 것은 프로토콜 위반**입니다. 중간에 허용되는 것은 control 프레임(ping/pong/close)뿐입니다. 브라우저는 이를 감지하고 즉시 **1002 Protocol Error**로 연결을 종료합니다.

이것은 타이밍에 따른 간헐적 버그가 아니라, 동기화가 없는 상태에서 **구조적으로 보장된 충돌**입니다.

### 보충: Tomcat의 실제 실패 경로

위 설명은 RFC 6455 레벨에서 "프레임이 물리적으로 섞인다"는 개념적 모델입니다. 실제 Tomcat 8.5+/9.x에서는 이보다 한 단계 앞에서 실패하는 경우가 더 흔합니다.

`WsRemoteEndpointImplBase` 내부에는 `messagePartInProgress`라는 플래그가 있어서, 한 메시지의 프레임 시퀀스가 진행 중일 때 다른 스레드가 `sendMessage()`를 호출하면 **프레임이 실제로 섞이기 전에 `IllegalStateException`을 던집니다.** 이 예외가 발생하면 진행 중이던 프레임 시퀀스가 불완전한 상태(incomplete fragmentation)로 남고, 수신 측 브라우저는 완결되지 않은 fragmentation 시퀀스를 프로토콜 위반으로 판단하여 1002를 발생시킵니다.

즉, 실제 관찰되는 failure path는:

```
동시 sendMessage() 호출
  → Tomcat 내부 messagePartInProgress 체크
  → IllegalStateException 발생
  → 진행 중이던 fragmentation 시퀀스가 미완결 상태로 중단
  → 수신 브라우저가 incomplete fragmentation 감지
  → 1002 Protocol Error로 연결 종료
```

**interleaving(프레임이 섞임)**보다는 **incomplete fragmentation(프레임 시퀀스가 미완결)**에 가까운 실패입니다. 근본 원인(동기화 없는 동시 전송)과 해결 방향은 동일하지만, 정확한 실패 메커니즘을 구분하면 디버깅 시 서버 로그에서 `IllegalStateException`을 먼저 찾아볼 수 있다는 실용적 이점이 있습니다.

---

## 해결 후보군

원인은 명확합니다. 같은 세션에 대한 동시 전송을 막아야 합니다. 네 가지 방법을 검토했습니다.

### 후보 1: `ConcurrentWebSocketSessionDecorator`

Spring이 공식 제공하는 동시 전송 래퍼입니다.

```java
@Override
public void afterConnectionEstablished(WebSocketSession session) {
    WebSocketSession concurrentSession = new ConcurrentWebSocketSessionDecorator(
        session, 5000, 100 * 1024 * 1024
    );
    sessions.put(session.getId(), new UserSession(session.getId(), nickname, concurrentSession));
}
```

#### 내부 동작

단순한 `synchronized`가 아니라 **Queue + Non-blocking Lock** 패턴으로 동작합니다.

```java
// Spring ConcurrentWebSocketSessionDecorator 내부 (간략화)

private final Queue<WebSocketMessage<?>> buffer = new LinkedBlockingQueue<>();
private final Lock flushLock = new ReentrantLock();

@Override
public void sendMessage(WebSocketMessage<?> message) throws IOException {
    // 1. 메시지를 큐에 넣는다 (모든 스레드가 즉시 가능)
    buffer.add(message);

    // 2. 큐를 비우는 역할을 시도한다
    do {
        if (!tryFlushMessageBuffer()) {
            // 다른 스레드가 이미 flush 중 → 이 스레드는 할 일 끝
            checkSessionLimits();
            break;
        }
    } while (!buffer.isEmpty() && !shouldNotSend());
}

private boolean tryFlushMessageBuffer() {
    if (flushLock.tryLock()) {  // ★ non-blocking: 실패하면 즉시 리턴
        try {
            while (true) {
                WebSocketMessage<?> msg = buffer.poll();
                if (msg == null) break;
                getDelegate().sendMessage(msg);  // 실제 전송
            }
        } finally {
            flushLock.unlock();
        }
        return true;
    }
    return false;
}
```

`synchronized`는 모든 스레드가 블로킹 대기하지만, 이 래퍼는 **비블로킹 tryLock**을 사용합니다. 락을 획득한 하나의 스레드가 큐의 모든 메시지를 drain하고, 나머지 스레드는 메시지를 큐에 넣고 즉시 리턴합니다.

또한 Slow consumer 보호 기능이 있습니다:

```java
private void checkSessionLimits() {
    if (getTimeSinceSendStarted() > getSendTimeLimit()) {
        limitExceeded("Send timeout");  // → 세션 종료
    }
    if (getBufferSize() > getBufferSizeLimit()) {
        switch (overflowStrategy) {
            case TERMINATE → limitExceeded("Buffer overflow");
            case DROP → { /* 가장 오래된 메시지부터 버림 */ }
        }
    }
}
```

#### 평가

**장점**: Spring 공식 솔루션, 비블로킹, Slow consumer 보호

**문제점**:
- `afterConnectionEstablished()`에서 세션을 래핑하고, 이후 모든 코드가 래핑된 세션만 사용해야 합니다. 핸들러 파라미터의 `session`(raw)과 Map에 저장된 `decorated`가 다른 객체이므로 혼용하면 동기화가 깨집니다.
- `sendTimeLimit`과 `bufferSizeLimit` 튜닝이 필요합니다. 바이너리 릴레이 중 sendTimeLimit에 걸려 세션이 의도치 않게 종료될 수 있습니다.
- `sendMessage()` 리턴이 전송 완료를 보장하지 않습니다. 파일 전송 흐름(meta → binary → complete)의 순서 제어가 어려워집니다.

### 후보 2: Per-session `ReentrantLock`

세션 ID별로 `ReentrantLock`을 만들어 동기화합니다.

```java
private final Map<String, ReentrantLock> sessionLocks = new ConcurrentHashMap<>();

private void sendSafe(WebSocketSession session, WebSocketMessage<?> message) {
    ReentrantLock lock = sessionLocks.computeIfAbsent(session.getId(), k -> new ReentrantLock());
    lock.lock();
    try {
        if (session.isOpen()) {
            session.sendMessage(message);
        }
    } catch (Exception e) {
        logger.error("Error sending to {}: {}", session.getId(), e.getMessage(), e);
    } finally {
        lock.unlock();
    }
}
```

`tryLock(timeout)`으로 타임아웃을 걸 수 있다는 점이 `synchronized`에 없는 기능입니다:

```java
if (!lock.tryLock(5, TimeUnit.SECONDS)) {
    logger.warn("Send timeout for session {}", session.getId());
    return;
}
```

#### 평가

**장점**: 타임아웃 설정 가능, 세션별 독립 락

**문제점**:
- 바이너리 릴레이는 네트워크 상태에 따라 전송 시간이 크게 달라지므로 적절한 timeout 값을 정하기 어렵습니다.
- `lock()`/`unlock()` 패턴은 `finally` 블록을 반드시 작성해야 합니다. 빠뜨리면 데드락입니다. `synchronized`는 스코프를 벗어나면 JVM이 자동으로 해제하므로 이런 실수가 구조적으로 불가능합니다.
- Netdrops 규모에서 `synchronized` 대비 실질적 이점이 없습니다.

### 후보 3: Per-session `synchronized`

세션 ID별로 전용 락 객체를 만들어 `synchronized`를 거는 방식입니다.

```java
private final Map<String, Object> sessionLocks = new ConcurrentHashMap<>();

private void sendSafe(WebSocketSession session, WebSocketMessage<?> message) {
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

#### 평가

**장점**:
- 코드가 가장 단순합니다. `finally` 블록이 필요 없고, JVM이 unlock을 보장합니다.
- 전송 완료 = 메서드 리턴이라는 동기 시맨틱을 유지합니다.
- 세션 ID 기반 전용 락이므로 Spring/Tomcat 내부와 락 경합이 없습니다.
- 세션별 독립 락이므로 서로 다른 세션 간 전송은 병렬로 수행됩니다.

**문제점**:
- 바이너리 전송이 완료될 때까지 같은 세션으로 보내려는 다른 스레드가 블로킹 대기합니다.
- Slow consumer 보호가 없습니다.
- `afterConnectionClosed()`에서 `sessionLocks.remove()`를 해야 메모리 누수를 방지할 수 있습니다.

> 참고: `synchronized(session)`처럼 세션 객체 자체를 락으로 사용하는 방법도 있지만, 외부 라이브러리가 소유한 객체를 애플리케이션의 모니터 락으로 사용하면 Spring/Tomcat 내부와 의도하지 않은 락 경합이 발생할 수 있으므로 제외했습니다.

### 후보 4: 세션별 전송 큐 (아키텍처 레벨 대안)

위 세 후보는 모두 "동시 전송을 락으로 직렬화"하는 접근입니다. 근본적으로 다른 방향도 있습니다: **브로드캐스트와 릴레이의 경합 자체를 제거하는 설계**입니다.

```java
private final Map<String, BlockingQueue<WebSocketMessage<?>>> sendQueues = new ConcurrentHashMap<>();

// 모든 전송 경로에서 직접 send 대신 큐에 넣기
private void enqueue(String sessionId, WebSocketMessage<?> message) {
    sendQueues.computeIfAbsent(sessionId, k -> new LinkedBlockingQueue<>()).add(message);
}

// 세션별 전용 스레드 또는 이벤트 루프가 큐를 drain
private void flushLoop(String sessionId, WebSocketSession session) {
    WebSocketMessage<?> msg;
    while (session.isOpen() && (msg = sendQueues.get(sessionId).poll()) != null) {
        session.sendMessage(msg);
    }
}
```

이 방식이면 `broadcastUserList()`는 큐에 메시지를 넣고 즉시 리턴합니다. 실제 전송은 세션별로 단일 스레드가 담당하므로 동시 전송 자체가 구조적으로 불가능하고, 락이 필요 없습니다.

#### 평가

**장점**: 동시 전송 경합을 구조적으로 제거, 비블로킹 enqueue

**문제점**:
- 세션별 전용 스레드 또는 이벤트 루프를 관리해야 합니다. 세션 생성/종료에 따른 스레드 라이프사이클 관리가 추가됩니다.
- 파일 전송 흐름(meta → binary → complete)에서 "binary 전송이 실제로 완료되었는지"를 확인하려면 별도의 completion callback이 필요합니다. 동기 시맨틱(전송 완료 = 메서드 리턴)을 잃게 됩니다.
- Netdrops의 동시 접속 규모(소수)에서는 세션별 스레드가 대부분 idle 상태로 낭비됩니다.
- 사실상 `ConcurrentWebSocketSessionDecorator`의 Queue + flushLock 패턴을 직접 구현하는 것과 비슷한데, Spring이 이미 검증된 구현을 제공하고 있으므로 직접 구현의 이점이 제한적입니다.

**왜 락 기반 접근을 선택했는가**: Netdrops는 동시 충돌 빈도가 극히 낮고(전송 중 userList 브로드캐스트가 겹치는 경우뿐), 충돌 시 대기하는 메시지도 수 KB 텍스트 하나입니다. 이 규모에서 큐 + 전용 스레드의 구조적 복잡성은 해결하려는 문제 대비 과도합니다. 반면, 동시 접속이 수백 이상으로 늘어나고 브로드캐스트 빈도가 높아진다면, 큐 기반 설계 또는 `ConcurrentWebSocketSessionDecorator`로의 전환을 검토해야 합니다.

### 비교

| | ConcurrentWebSocket SessionDecorator | ReentrantLock | Per-session synchronized | 세션별 전송 큐 |
|---|---|---|---|---|
| **블로킹** | 비블로킹 (tryLock) | 블로킹 | 블로킹 | 비블로킹 (enqueue) |
| **Slow Consumer 보호** | sendTimeLimit + bufferSizeLimit | tryLock(timeout) | 없음 | 큐 크기 제한 가능 |
| **구현 복잡도** | 중간 (세션 래핑 필요) | 중간 (finally 필수) | **낮음** | 높음 (스레드 라이프사이클) |
| **락 안전성** | 내부 관리 | 전용 락 | 전용 락 | 락 불필요 |
| **전송 완료 = 리턴** | **아니오** | 예 | 예 | **아니오** |
| **메시지 순서** | FIFO 큐 보장 | 보장 | 보장 | FIFO 큐 보장 |

---

## 결론: Per-session synchronized

Netdrops의 사용 패턴을 기준으로 판단했습니다.

### ConcurrentWebSocketSessionDecorator가 오버스펙인 이유

이 래퍼의 비블로킹 tryLock, 메시지 큐 버퍼링, Slow consumer 감지는 **수백~수천 클라이언트에게 동시 브로드캐스트하는 시나리오**(채팅, 실시간 대시보드)에서 빛나는 기능입니다.

Netdrops는 **1:1 파일 전송** 서비스입니다. 하나의 세션에 동시 전송이 충돌하는 경우는 "전송 중 다른 유저 접속으로 인한 userList 브로드캐스트" 정도입니다. 이때 충돌하는 메시지는 수 KB짜리 JSON 텍스트 하나뿐이므로, 바이너리 전송이 끝나기를 기다리는 블로킹 대기는 사용자가 체감할 수 없는 지연입니다. 그리고 `sendMessage()` 리턴이 전송 완료를 보장하지 않는다는 특성은 파일 전송 흐름(meta → binary → complete) 제어를 오히려 어렵게 만듭니다.

### ReentrantLock이 불필요한 이유

`tryLock(timeout)`은 유용하지만, 바이너리 릴레이의 전송 시간은 네트워크 상태에 따라 크게 달라지므로 적절한 timeout 값을 정하기 어렵습니다. `synchronized`의 JVM 레벨 안전성(스코프를 벗어나면 자동 해제)을 포기할 만한 이유가 없습니다.

### Per-session synchronized가 맞는 이유

- **동시 충돌 빈도가 극히 낮습니다.** 전송 중 userList 브로드캐스트가 겹치는 경우뿐이고, 대기하는 메시지는 수 KB 텍스트 하나입니다.
- **코드가 가장 단순합니다.** `sendSafe()` 하나로 모든 전송 경로를 통일할 수 있고, 세션 래핑이나 `finally` 패턴이 필요 없습니다.
- **전송 완료 = 메서드 리턴**이라는 동기 시맨틱을 유지합니다. 파일 전송 흐름의 순서 보장이 직관적입니다.

> 1:1 전송에 신호등(synchronized)이면 충분합니다. 교통 관제 시스템(ConcurrentWebSocketSessionDecorator)은 교차로가 복잡한 도시(대규모 브로드캐스트)에 필요한 것입니다.

---

## 적용과 검증

### 수정 코드

```java
private final Map<String, Object> sessionLocks = new ConcurrentHashMap<>();

private void sendSafe(WebSocketSession session, WebSocketMessage<?> message) {
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

기존의 모든 `session.sendMessage()` 호출을 `sendSafe()`로 교체했습니다.

**Before:**
```java
// broadcastUserList()
sessions.values().forEach(user -> {
    user.getSession().sendMessage(new TextMessage(message));
});

// handleBinaryMessage()
targetUser.getSession().sendMessage(message);
```

**After:**
```java
// broadcastUserList()
sessions.values().forEach(user -> sendSafe(user.getSession(), msg));

// handleBinaryMessage()
sendSafe(target.getSession(), new BinaryMessage(data));
```

세션 종료 시 락 객체를 정리하여 메모리 누수를 방지합니다:

```java
@Override
public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
    sessions.remove(session.getId());
    fileTransferMap.remove(session.getId());
    sessionLocks.remove(session.getId());  // ← 락 객체 정리
    broadcastUserList();
}
```

### 검증

수정 후 동일한 "A→B 전송 중 C 접속" 시나리오를 재현했습니다:

```
INFO  Transfer mapping: abc123 -> def456
INFO  Text from abc123: type=meta
INFO  Binary: sender=abc123, target=def456, size=423178
INFO  Text from abc123: type=complete
INFO  Transfer complete, mapping removed: sender=abc123
```

**1002 에러 없이 정상 전송 완료.** C가 접속하여 `broadcastUserList()`가 호출되었지만, per-session lock에 의해 바이너리 전송 완료 후 순차적으로 처리되었습니다.

---

## 남은 과제

Per-session `synchronized`로 1002 문제는 해결했지만, 현재 구현에는 인지하고 있어야 할 한계점들이 있습니다.

### 1. 락 객체 제거 시점의 레이스 컨디션

`afterConnectionClosed()`에서 `sessionLocks.remove()`를 호출하는데, 이 시점에 다른 스레드가 이미 `computeIfAbsent`로 락 객체를 가져와서 `synchronized` 블록 진입 직전일 수 있습니다.

```
Thread A (broadcastUserList):     lock = sessionLocks.computeIfAbsent("B", ...)  // 락 객체 참조 획득
Thread B (afterConnectionClosed): sessionLocks.remove("B")                       // 맵에서 제거
Thread C (broadcastUserList):     lock = sessionLocks.computeIfAbsent("B", ...)  // 새로운 락 객체 생성!
```

Thread A와 Thread C가 서로 다른 `Object` 인스턴스에 `synchronized`를 걸게 되어 동기화가 깨질 수 있습니다. 발생 빈도는 극히 낮지만(세션 종료 직전의 마지막 브로드캐스트와 겹쳐야 함), 이론적으로 가능한 결함입니다.

현재 Netdrops에서는 세션이 종료되는 시점에 해당 세션으로의 전송은 `session.isOpen()` 체크에서 걸러지므로 실질적 피해는 없습니다. 하지만 엄밀한 해결을 위해서는 `remove()` 대신 세션 종료 플래그를 두고 `sendSafe()` 내부에서 체크하거나, 락 객체의 라이프사이클을 세션 객체와 함께 관리하는 방식을 고려할 수 있습니다.

### 2. sendSafe의 조용한 실패

현재 `sendSafe()`는 예외를 `catch`하고 로그만 남깁니다. **브로드캐스트 경로**에서는 이것이 올바른 동작입니다. 한 세션에 대한 전송 실패가 다른 세션의 브로드캐스트를 중단시켜서는 안 됩니다.

하지만 **파일 전송 경로**(meta → binary → complete)에서는 문제가 됩니다. binary 전송이 실패했는데 예외가 삼켜지면, 송신 측은 complete까지 보내고 "전송 성공"으로 인식하지만, 수신 측은 불완전한 파일을 받는 상황이 됩니다.

```java
// 현재: 브로드캐스트와 릴레이 모두 동일한 sendSafe()를 사용
sendSafe(target.getSession(), new BinaryMessage(data));  // 실패해도 예외 안 남
sendSafe(target.getSession(), completeMessage);            // "성공"으로 처리됨
```

전송 경로의 `sendSafe()`에서는 예외를 호출자에게 전파하거나, 최소한 전송 실패 시 `fileTransferMap`을 정리하는 로직이 필요합니다. 브로드캐스트 경로에서만 조용히 실패하도록, 두 경로를 구분하는 것이 다음 개선 방향입니다.

### 3. Slow Consumer에 의한 블로킹 전파

현재 구현에서 "충돌 빈도가 낮으므로 블로킹 대기가 감당 가능하다"는 판단은 **정상적인 수신자** 기준입니다.

만약 수신자 B의 네트워크가 불안정하여 TCP send buffer가 가득 차면, `sendMessage()`가 장시간 블로킹됩니다. 이때 `synchronized` 블록을 잡고 있으므로, 해당 세션으로 보내려는 **모든 스레드**(브로드캐스트 포함)가 대기하게 됩니다.

```
Thread 1: synchronized(lockB) { session.sendMessage(binary) }  ← TCP buffer full, 장시간 블로킹
Thread 2: synchronized(lockB) { session.sendMessage(userList) } ← Thread 1 대기
Thread 3: synchronized(lockB) { session.sendMessage(userList) } ← Thread 1 대기
... Tomcat I/O 스레드 풀이 점진적으로 소진
```

Tomcat의 기본 스레드 풀 크기(200)를 고려하면 현재 규모에서 당장 문제가 되지는 않습니다. 하지만 동시 접속이 늘어나거나 네트워크 불안정이 빈번한 환경에서는, `ReentrantLock.tryLock(timeout)` 또는 `ConcurrentWebSocketSessionDecorator`의 `sendTimeLimit`으로 전환하여 Slow consumer를 감지하고 세션을 정리하는 방어 로직이 필요합니다.

**현재 Netdrops의 규모(소수 동시 접속, LAN 환경)에서는 문제없지만, 스케일 시 재검토가 필요한 지점입니다.**

---

## 마치며

### 1. WebSocket 동시 전송은 스펙이 금지한다

JSR 356 스펙과 Spring 공식 문서가 명시합니다. `WebSocketSession.sendMessage()`는 thread-safe하지 않으며, 동시 호출 시 프레임 인터리빙으로 1002 Protocol Error가 발생합니다. WebSocket 서버를 구현할 때 동기화 전략은 선택이 아니라 필수입니다.

### 2. 재현 조건이 원인을 가리킨다

"C가 접속할 때만 실패한다"는 조건이 곧 원인의 힌트였습니다. C의 접속이 B의 소켓에 영향을 주는 코드 경로(`broadcastUserList`)를 찾으면, 동시 전송이라는 근본 원인에 도달할 수 있었습니다.

### 3. 동시성 제어 도구는 서비스 특성에 맞게 선택한다

`ConcurrentWebSocketSessionDecorator`는 대규모 브로드캐스트에 강력하고, `ReentrantLock`은 세밀한 타임아웃 제어에 유용하며, 큐 기반 설계는 경합 자체를 구조적으로 제거합니다. 하지만 Netdrops처럼 충돌 빈도가 낮고 1:1 릴레이가 중심인 서비스에서는 per-session `synchronized`가 가장 단순하고 효과적입니다. 도구를 선택할 때 **"얼마나 자주 충돌하는가"**와 **"충돌 시 대기 비용이 감당 가능한가"**를 먼저 판단해야 합니다. 동시에, 선택한 솔루션의 한계(락 객체 라이프사이클, 에러 전파 전략, Slow consumer 대응)를 인식하고 있어야 스케일 시점에 올바른 전환이 가능합니다.

### 참고 자료

- [JSR 356 — Java WebSocket API Specification](https://www.oracle.com/technical-resources/articles/java/jsr356.html)
- [Spring WebSocket — Sending Messages](https://docs.spring.io/spring-framework/reference/web/websocket/server.html)
- [ConcurrentWebSocketSessionDecorator 소스코드](https://github.com/spring-projects/spring-framework/blob/main/spring-websocket/src/main/java/org/springframework/web/socket/handler/ConcurrentWebSocketSessionDecorator.java)
- [RFC 6455 Section 5.4 — Fragmentation](https://datatracker.ietf.org/doc/html/rfc6455#section-5-4)
