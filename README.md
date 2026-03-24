# NetDrops

### 프로젝트 개요

- 목적: Netdrops는 메신저로 원본 사진을 보낼 때 압축으로 인해 사진의 화질이 저하되는 불편함과 특정 브랜드의 생태계의 디바이스들끼리만 파일을 쉽게 공유할 수 있는 불편함을 기술적으로 극복할 수 있지 않을까 라는 물음에서 시작하여 운영 중인 프로젝트입니다.

---

### 담당 역할

- WebSocket 서버 세팅 및 핸들러 구현
- 사용자 세션 관리 로직 설계
- 대용량 바이너리 메시지(파일) 스트리밍 처리
- 동시 파일 전송 제어 및 안정성 보강

---

### 기술 스택

- **BackEnd**: JDK 21, Gradle, Spring Boot
- **FrontEnd**: React, Axios
- **Protocol:** WebSocket

---

### 주요 기능

- **실시간 세션 관리**
    - 접속 시 닉네임 생성 후 초기화 메시지(`init`) 전송
    - `sessions: Map<sessionId, UserSession>` 으로 모든 연결 상태 추적
    - 접속 해제 시 자동 제거 및 남은 사용자에게 유저 리스트 브로드캐스트
- **텍스트 메시지 라우팅**
    - `type=request`/`response` 기반 1:1 연결 요청 및 응답 전달
    - `busy` 플래그로 동시 연결 충돌 방지
- **다중 파일 전송 매핑**
    - `multiFileTransferMap: Map<senderId, Map<fileId, targetId>>` 기반
    - 최대 동시 전송 파일 수(`MAX_CONCURRENT_FILES`) 제한
- **바이너리 메시지(파일) 스트리밍**
    - `BinaryMessage` 페이로드에서 UUID(36바이트) 분리 후 실제 파일 데이터 전달
    - 전송 완료 시 매핑 제거 및 `busy` 상태 해제

---

### 문제 분석

일반적으로 사진과 같은 작은 파일을 전송할 때에는 A사의 AirDrop, K사의 메신저를 통하여 전송하게 됩니다. 하지만 각 서비스는 모두 다음과 같은 한계를 가집니다.

<aside>

1. A사의 AirDrop 서비스는 타 사의 디바이스를 이용하고 있는 경우 디바이스간 파일 전송이 불가능합니다.

2. K사의 메신저는 전송 속도가 느리고 같은 사용자의 다른 디바이스로 전송하려면 두 개의 디바이스 모두 메신저가 설치되어야한다는 한계점이 존재합니다. 

</aside>

따라서 이러한 시장 서비스들의 한계를 기술적으로 극복하고자 하였습니다. 구현해야하는 요구사항은 다음과 같이 정의하였습니다.

```java
1. 사용자는 임의로 부여받은 각 디바이스의 번호를 한눈에 확인하고 connection을 맺을 수 있을 것.
2. 사용자는 1장의 사진이 아닌 여러 장의 사진을 병목없이 전송할 수 있어야할 것.
3. 연결을 맺은 두 디바이스끼리 파일을 전송중일 때에는 다른 디바이스의 방해가 없어야 할 것.
```

---

### 문제 해결 과정 1 (실시간 접속·종료 이벤트 브로드캐스트)

앞서 이야기한 것과 같이 사용자는 실시간으로 서버에 접속한 디바이스를 모두 확인할 수 있어야합니다. 따라서 접속하거나 종료할 때마다 클라이언트가 폴링을 통해 주기적으로 상태를 확인하는 방식 보다는 접속해있을 때에는 지속적으로 연결 상황을 확인할 수 있게 WebSocket 프로토콜을 채택하여 구현하였습니다. 

사용자는 다음과 같은 흐름을 거치게 됩니다.

```java
1. 새 세션 등록 및 초기화 메세지 전송
    클라이언트가 WebSocket 연결을 맺으면(afterConnectionEstablished)
    랜덤 닉네임을 생성해 sessions 맵에 저장
    
2. 전체 사용자 리스트 브로드캐스트
    연결이 맺어지거나 끊어질 때마다(afterConnectionEstablished·afterConnectionClosed)
    현재 sessions 맵에 남아 있는 모든 sessionId·nickname 정보를 수집해
    {"type":"userList","users":[…]} 형태의 JSON으로 직렬화한 뒤
    등록된 모든 활성 세션에 한 번에 전송
    
3. 세션 종료 처리 
```

- 관련 코드
    
    ```java
    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        // 1. 새로운 세션 등록
        String nickname = NicknameGenerator.generate();
        sessions.put(session.getId(), new UserSession(session.getId(), nickname, session));
        
        // 2. init 메시지 전송
        session.sendMessage(new TextMessage(
            objectMapper.writeValueAsString(Map.of(
                "type", "init",
                "sessionId", session.getId(),
                "nickname", nickname
            ))
        ));
        
        // 3. 모든 클라이언트에 유저 리스트 브로드캐스트
        broadcastUserList();
    }
    
    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sessions.remove(session.getId());
        broadcastUserList();
    }
    
    private void broadcastUserList() {
        // 현재 연결된 모든 사용자 정보 수집
        List<Map<String,String>> userList = sessions.values().stream()
            .map(u -> Map.of("sessionId", u.getSessionId(), "nickname", u.getNickname()))
            .toList();
        
        // JSON 메시지 생성
        String message = objectMapper.writeValueAsString(
            Map.of("type", "userList", "users", userList)
        );
        
        // 모든 활성 세션에 전송
        sessions.values().forEach(u -> {
            u.getSession().sendMessage(new TextMessage(message));
        });
    }
    
    ```
    

![image.png](NetDrops%2024838be7820480779e9ef7711f71f592/image.png)

---

### 문제 해결 과정 2 (중복 요청 차단)

한 세션이 이미 다른 사용자와 1:1 연결 요청 중이거나 파일 전송 중일 때, 추가로 `request` 메시지를 보내면 요청이 중복 전달되어 상태가 꼬이거나, 불필요한 메시지 브로드캐스트가 발생하게 됩니다. 따라서 연결 요청 중인 세션들은 다른 사용자나 디바이스가 접근할 수 없도록 처리해야합니다. 

보안과 비용상의 문제로 사용자들의 전송하는 파일을 서버에 저장할 수 없고, 최대한 빠르게 사진을 전송할 수 있도록 회원의 개념도 존재하지 않아서 Session 객체만으로 동시성을 조작해야만 했습니다. 

해결 방안은 다음과 같습니다.

1. UserSession 객체에 AtomicBoolean busy flag를 두고 
2. `request` 수신 시 송신자와 수신자 양쪽에서 busy 상태를 검사합니다.
    1. 여기서 둘 중 하나라도 true라면 즉시 에러를 발생시킵니다.
    2. 모두 false 일 때만 양쪽을 busy = true로 설정하고 요청을 전달합니다.
3. `response` 처리에서 거절 시(`accepted = false`) 양쪽 `busy = false` 해제합니다.
4. 모든 파일 청크 전송이 완료된 후에도 `busy`를 `false`로 해제

따라서 

- 동일 세션에 대한 중복 요청 차단으로 불필요한 메시지 전달 제거할 수 있게 되었습니다.
- 요청 단계에서 충돌을 사전 방지해 안정적인 1:1 연결 보장할 수 있어졌습니다.
- `busy` 플래그로 간단하면서도 명확한 동시성 제어 달성하였습니다.

![image.png](NetDrops%2024838be7820480779e9ef7711f71f592/image%201.png)

---

### 문제 해결 과정 3 (스레드-안전 세션 관리)

WebSocket 핸들러는 내부의 I/O 쓰레드 풀에서 **동시에** 여러 메서드를 호출합니다. 예를 들어 두 클라이언트가 거의 같은 시점에 접속하거나 메시지를 보낼 때 다음과 같은 위험이 있습니다.

1. **HashMap 동시 쓰기 문제**
    - 만약 일반 `HashMap`을 사용한다면
        
        ```java
        sessions.put(session.getId(), userSession);
        ```
        
        두 쓰레드가 거의 동시에 `put()`을 호출하면 내부 버킷 구조가 손상돼 `ConcurrentModificationException` 이 발생하거나 무한루프에 빠질 수 있습니다.
        
2. **동시 삭제·방송 충돌**
    - 한 쓰레드가 `afterConnectionClosed()` 에서 `sessions.remove(id)` 를 실행하는 동안,
    - 다른 쓰레드가 `broadcastUserList()` 에서 `sessions.values().forEach(...)` 로 순회하면
    - 컬렉션의 일관성이 깨져 잘못된 사용자 리스트가 전송되거나 예외가 발생할 수 있습니다.

따라서 아래와 같이 이 문제를 해결하였습니다.

1. **`ConcurrentHashMap`**
    - `sessions` 와 `multiFileTransferMap` 모두 `new ConcurrentHashMap<>()` 으로 선언
    - 내부적으로 세그먼트 락 또는 CAS 기반 구조를 사용하여
        - **여러 쓰레드가 동시에** `get()`, `put()`, `remove()` 해도 안전하고
        - 반복(iteration) 중에도 구조 변경이 가능해 **CME** 발생 위험이 없게끔 구현하였습니다.
2. **`computeIfAbsent()`**
    
    ```java
    multiFileTransferMap
      .computeIfAbsent(senderId, id -> new ConcurrentHashMap<>());
    ```
    
    - 존재하지 않을 때만 **원자적으로** 새 맵을 생성·저장하게 하고 중복 생성이나 race 없이 **한 번만** 초기화하게 하였습니다.
3. **`AtomicBoolean busy`**
    - `UserSession` 내부에 `private final AtomicBoolean busy = new AtomicBoolean(false);`
    - `busy.get()`/`busy.set(true)` 은 CAS 연산으로 연산하게 하고 임계 구역 없이도 안전하게 busy 상태로 전환하게 하여 두 쓰레드가 거의 동시에 `setBusy(true)` 해도 둘 중 하나만 성공적으로 토글
        
        할 수 있게 하였습니다.
        

### 마치며

일상생활에 있는 문제와 학교 커뮤니티에서의 언급된 문제를 작지만 기술적으로 해결해보고자한 매우 가치 있는 경험이었습니다. 조금 더 발전시킬 수 있다면 로컬 어플리케이션으로 개발하여 보다 많은 사람들에게 유의미한 가치를 창출해낼 수 있을 것 같습니다.