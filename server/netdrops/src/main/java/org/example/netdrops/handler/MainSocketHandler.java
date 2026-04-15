package org.example.netdrops.handler;

import org.example.netdrops.model.UserSession;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.MeterRegistry;
import org.example.netdrops.util.NicknameGenerator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.BinaryWebSocketHandler;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.List;
import java.util.stream.Collectors;

@Component
public class MainSocketHandler extends BinaryWebSocketHandler {

    private static final Logger logger = LoggerFactory.getLogger(MainSocketHandler.class);
    private static final long MAX_BINARY_SIZE = 512L * 1024; // 512KB per chunk

    private final Map<String, UserSession> sessions = new ConcurrentHashMap<>();
    private final Map<String, String> fileTransferMap = new ConcurrentHashMap<>();
    private final Map<String, Object> sessionLocks = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper = new ObjectMapper();

    private final MeterRegistry registry;
    private final Counter sessionsOpened;
    private final Counter sessionsClosed;
    private final Counter transferBytes;
    private final DistributionSummary transferSize;
    private final Counter oversizeRejected;

    public MainSocketHandler(MeterRegistry registry) {
        this.registry = registry;

        registry.gauge("netdrops.ws.sessions.active", sessions, Map::size);
        registry.gauge("netdrops.ws.transfer.active", fileTransferMap, Map::size);

        this.sessionsOpened = Counter.builder("netdrops.ws.sessions.opened")
                .description("Total WebSocket sessions opened")
                .register(registry);
        this.sessionsClosed = Counter.builder("netdrops.ws.sessions.closed")
                .description("Total WebSocket sessions closed")
                .register(registry);
        this.transferBytes = Counter.builder("netdrops.ws.transfer.bytes")
                .description("Total bytes relayed for binary transfers")
                .baseUnit("bytes")
                .register(registry);
        this.transferSize = DistributionSummary.builder("netdrops.ws.transfer.size")
                .description("Distribution of binary payload sizes")
                .baseUnit("bytes")
                .publishPercentiles(0.5, 0.95, 0.99)
                .register(registry);
        this.oversizeRejected = Counter.builder("netdrops.ws.oversize.rejected")
                .description("Binary payloads rejected for exceeding size limit")
                .register(registry);
    }

    private void countMessage(String direction, String type) {
        Counter.builder("netdrops.ws.messages")
                .tag("direction", direction)
                .tag("type", type)
                .register(registry)
                .increment();
    }

    private void countError(String stage) {
        Counter.builder("netdrops.ws.errors")
                .tag("stage", stage)
                .register(registry)
                .increment();
    }

    private void sendSafe(WebSocketSession session, WebSocketMessage<?> message) {
        Object lock = sessionLocks.computeIfAbsent(session.getId(), k -> new Object());
        synchronized (lock) {
            try {
                if (session.isOpen()) {
                    session.sendMessage(message);
                }
            } catch (Exception e) {
                countError("send");
                logger.error("Error sending to {}: {}", session.getId(), e.getMessage(), e);
            }
        }
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        session.setBinaryMessageSizeLimit(512 * 1024);  // 512KB
        session.setTextMessageSizeLimit(16 * 1024);          // 16KB

        String nickname = NicknameGenerator.generate();
        sessions.put(session.getId(), new UserSession(session.getId(), nickname, session));
        sessionsOpened.increment();
        logger.info("Connected: sessionId={}, nickname={}", session.getId(), nickname);

        try {
            String initMsg = objectMapper.writeValueAsString(
                    Map.of("type", "init", "sessionId", session.getId(), "nickname", nickname)
            );
            sendSafe(session, new TextMessage(initMsg));
        } catch (Exception e) {
            countError("handle");
            logger.error("Error creating init message: {}", e.getMessage(), e);
        }

        broadcastUserList();
    }

    private void broadcastUserList() {
        try {
            List<Map<String, String>> userList = sessions.values().stream()
                    .map(u -> Map.of("sessionId", u.getSessionId(), "nickname", u.getNickname()))
                    .collect(Collectors.toList());
            String json = objectMapper.writeValueAsString(Map.of("type", "userList", "users", userList));
            TextMessage msg = new TextMessage(json);
            sessions.values().forEach(user -> sendSafe(user.getSession(), msg));
        } catch (Exception e) {
            countError("handle");
            logger.error("Error broadcasting user list: {}", e.getMessage(), e);
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        try {
            JsonNode json = objectMapper.readTree(message.getPayload());
            if (!json.has("type") || json.get("type").isNull()) {
                countMessage("in", "unknown");
                return;
            }

            String type = json.get("type").asText();
            logger.info("Text from {}: type={}", session.getId(), type);

            switch (type) {
                case "request": {
                    countMessage("in", "request");
                    String targetId = json.get("target").asText();
                    UserSession target = sessions.get(targetId);
                    if (target != null && target.getSession().isOpen()) {
                        sendSafe(target.getSession(), message);
                        countMessage("out", "request");
                    }
                    break;
                }
                case "response": {
                    countMessage("in", "response");
                    boolean accepted = json.get("data").get("accepted").asBoolean();
                    String senderId = json.get("target").asText();
                    UserSession sender = sessions.get(senderId);
                    if (sender != null && sender.getSession().isOpen()) {
                        sendSafe(sender.getSession(), message);
                        countMessage("out", "response");
                        if (accepted) {
                            fileTransferMap.put(senderId, session.getId());
                            logger.info("Transfer mapping: {} -> {}", senderId, session.getId());
                        }
                    }
                    break;
                }
                case "meta": {
                    countMessage("in", "meta");
                    String targetId = json.get("target").asText();
                    UserSession target = sessions.get(targetId);
                    if (target != null && target.getSession().isOpen()) {
                        sendSafe(target.getSession(), message);
                        countMessage("out", "meta");
                    }
                    break;
                }
                case "complete": {
                    countMessage("in", "complete");
                    String targetId = json.has("target") ? json.get("target").asText() : null;
                    if (targetId != null) {
                        UserSession target = sessions.get(targetId);
                        if (target != null && target.getSession().isOpen()) {
                            sendSafe(target.getSession(), message);
                            countMessage("out", "complete");
                        }
                    }
                    fileTransferMap.remove(session.getId());
                    logger.info("Transfer complete, mapping removed: sender={}", session.getId());
                    break;
                }
                default:
                    countMessage("in", "unknown");
                    logger.warn("Unknown type from {}: {}", session.getId(), type);
            }
        } catch (Exception e) {
            countError("parse");
            logger.error("Error handling text from {}: {}", session.getId(), e.getMessage(), e);
        }
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
        String senderId = session.getId();
        int payloadLength = message.getPayloadLength();

        countMessage("in", "binary");
        transferSize.record(payloadLength);

        if (payloadLength > MAX_BINARY_SIZE) {
            oversizeRejected.increment();
            sendSafe(session, new TextMessage("파일 크기가 100MB를 초과하였습니다."));
            return;
        }

        String targetId = fileTransferMap.get(senderId);
        logger.info("Binary: sender={}, target={}, size={}", senderId, targetId, payloadLength);

        if (targetId != null) {
            UserSession target = sessions.get(targetId);
            if (target != null && target.getSession().isOpen()) {
                byte[] data = new byte[payloadLength];
                message.getPayload().get(data);
                sendSafe(target.getSession(), new BinaryMessage(data));
                countMessage("out", "binary");
                transferBytes.increment(payloadLength);
            } else {
                fileTransferMap.remove(senderId);
            }
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        logger.info("Disconnected: sessionId={}, status={}", session.getId(), status);
        sessionsClosed.increment();
        sessions.remove(session.getId());
        fileTransferMap.remove(session.getId());
        sessionLocks.remove(session.getId());
        broadcastUserList();
    }
}
