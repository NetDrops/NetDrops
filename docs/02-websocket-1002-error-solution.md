## 논의점

### Spring 공식 권장 방법과의 비교

Spring의 `WebSocketSession.sendMessage()` Javadoc을 보면, 동시 전송 문제에 대해 `ConcurrentWebSocketSessionDecorator`를 권장하고 있습니다.

```java
/**
 * <p><strong>Note:</strong> The underlying standard WebSocket session (JSR-356) does
 * not allow concurrent sending. Therefore, sending must be synchronized. To ensure
 * that, one option is to wrap the {@code WebSocketSession} with the
 * {@link ConcurrentWebSocketSessionDecorator}.
 *
 * @see ConcurrentWebSocketSessionDecorator
 */
void sendMessage(WebSocketMessage<?> message) throws IOException;
```

이 래퍼는 내부적으로 큐 + 비블로킹 락 패턴으로 동작하며, Slow consumer 보호(sendTimeLimit, bufferSizeLimit) 기능도 제공합니다. 대규모 브로드캐스트 환경에서는 블로킹 없이 동시 전송을 처리할 수 있어 강력한 선택지입니다.

현재 Netdrops에서는 동시 충돌이 "파일 전송 중 userList 브로드캐스트" 한 가지로 제한되고 동시 접속 규모도 소수이기 때문에, 세션 래핑 없이 `sendSafe()` 메서드 하나로 충분히 해결할 수 있었습니다. 하지만 동시 접속이 늘어나거나 브로드캐스트 빈도가 높아진다면, `ConcurrentWebSocketSessionDecorator`로의 전환을 검토해야 합니다.

### Slow Consumer 문제

현재 `synchronized` 방식은 한 스레드가 `sendMessage()`를 완료할 때까지 다른 스레드가 블로킹 대기합니다. 정상적인 네트워크 환경에서는 대기 시간이 무시할 수 있는 수준이지만, 수신자의 네트워크가 불안정하여 TCP send buffer가 가득 차면 `sendMessage()` 자체가 장시간 블로킹될 수 있습니다. 이 경우 해당 세션으로 보내려는 모든 스레드가 함께 대기하게 됩니다.

현재 Netdrops의 규모에서는 문제없지만, 스케일 시 재검토가 필요한 지점입니다.
