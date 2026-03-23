package org.example.netdrops.handler;

import org.example.netdrops.model.UserSession;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.example.netdrops.util.NicknameGenerator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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

public class MainSocketHandler extends BinaryWebSocketHandler {

    private static final Logger logger = LoggerFactory.getLogger(MainSocketHandler.class);
    private static final long MAX_BINARY_SIZE = 100L * 1024 * 1024; // 100MB

    private final Map<String, UserSession> sessions = new ConcurrentHashMap<>();
    private final Map<String, String> fileTransferMap = new ConcurrentHashMap<>();
    private final Map<String, Object> sessionLocks = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper = new ObjectMapper();

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

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        String nickname = NicknameGenerator.generate();
        sessions.put(session.getId(), new UserSession(session.getId(), nickname, session));
        logger.info("Connected: sessionId={}, nickname={}", session.getId(), nickname);

        try {
            String initMsg = objectMapper.writeValueAsString(
                    Map.of("type", "init", "sessionId", session.getId(), "nickname", nickname)
            );
            sendSafe(session, new TextMessage(initMsg));
        } catch (Exception e) {
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
            logger.error("Error broadcasting user list: {}", e.getMessage(), e);
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        try {
            JsonNode json = objectMapper.readTree(message.getPayload());
            if (!json.has("type") || json.get("type").isNull()) return;

            String type = json.get("type").asText();
            logger.info("Text from {}: type={}", session.getId(), type);

            switch (type) {
                case "request": {
                    String targetId = json.get("target").asText();
                    UserSession target = sessions.get(targetId);
                    if (target != null && target.getSession().isOpen()) {
                        sendSafe(target.getSession(), message);
                    }
                    break;
                }
                case "response": {
                    boolean accepted = json.get("data").get("accepted").asBoolean();
                    String senderId = json.get("target").asText();
                    UserSession sender = sessions.get(senderId);
                    if (sender != null && sender.getSession().isOpen()) {
                        sendSafe(sender.getSession(), message);
                        if (accepted) {
                            fileTransferMap.put(senderId, session.getId());
                            logger.info("Transfer mapping: {} -> {}", senderId, session.getId());
                        }
                    }
                    break;
                }
                case "meta": {
                    String targetId = json.get("target").asText();
                    UserSession target = sessions.get(targetId);
                    if (target != null && target.getSession().isOpen()) {
                        sendSafe(target.getSession(), message);
                    }
                    break;
                }
                case "complete": {
                    String targetId = json.has("target") ? json.get("target").asText() : null;
                    if (targetId != null) {
                        UserSession target = sessions.get(targetId);
                        if (target != null && target.getSession().isOpen()) {
                            sendSafe(target.getSession(), message);
                        }
                    }
                    fileTransferMap.remove(session.getId());
                    logger.info("Transfer complete, mapping removed: sender={}", session.getId());
                    break;
                }
                default:
                    logger.warn("Unknown type from {}: {}", session.getId(), type);
            }
        } catch (Exception e) {
            logger.error("Error handling text from {}: {}", session.getId(), e.getMessage(), e);
        }
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
        String senderId = session.getId();

        if (message.getPayloadLength() > MAX_BINARY_SIZE) {
            sendSafe(session, new TextMessage("파일 크기가 100MB를 초과하였습니다."));
            return;
        }

        String targetId = fileTransferMap.get(senderId);
        logger.info("Binary: sender={}, target={}, size={}", senderId, targetId, message.getPayloadLength());

        if (targetId != null) {
            UserSession target = sessions.get(targetId);
            if (target != null && target.getSession().isOpen()) {
                sendSafe(target.getSession(), message);
            } else {
                fileTransferMap.remove(senderId);
            }
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        logger.info("Disconnected: sessionId={}, status={}", session.getId(), status);
        sessions.remove(session.getId());
        fileTransferMap.remove(session.getId());
        sessionLocks.remove(session.getId());
        broadcastUserList();
    }
}
