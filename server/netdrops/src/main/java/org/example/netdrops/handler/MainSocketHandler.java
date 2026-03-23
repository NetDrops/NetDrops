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
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        String randomNickname = NicknameGenerator.generate();
        UserSession userSession = new UserSession(session.getId(), randomNickname, session);
        sessions.put(session.getId(), userSession);
        logger.info("New connection: sessionId={}, nickname={}", session.getId(), randomNickname);

        try {
            String initMsg = objectMapper.writeValueAsString(
                    Map.of("type", "init", "sessionId", session.getId(), "nickname", randomNickname)
            );
            session.sendMessage(new TextMessage(initMsg));
        } catch (Exception e) {
            logger.error("Error sending init message to session {}: {}", session.getId(), e.getMessage(), e);
        }

        broadcastUserList();
    }

    private void broadcastUserList() {
        try {
            List<Map<String, String>> userList = sessions.values().stream()
                    .map(u -> Map.of("sessionId", u.getSessionId(), "nickname", u.getNickname()))
                    .collect(Collectors.toList());
            String message = objectMapper.writeValueAsString(Map.of("type", "userList", "users", userList));
            sessions.values().forEach(user -> {
                try {
                    user.getSession().sendMessage(new TextMessage(message));
                } catch (Exception e) {
                    logger.error("Error sending userList to session {}: {}", user.getSessionId(), e.getMessage(), e);
                }
            });
        } catch (Exception e) {
            logger.error("Error broadcasting user list: {}", e.getMessage(), e);
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        String payload = message.getPayload();
        logger.info("Received text from {}: {}", session.getId(), payload);

        try {
            JsonNode jsonNode = objectMapper.readTree(payload);

            // type 필드 누락 방어
            if (!jsonNode.has("type") || jsonNode.get("type").isNull()) {
                session.sendMessage(new TextMessage("type 필드가 없습니다."));
                return;
            }

            String type = jsonNode.get("type").asText();

            switch (type) {
                case "request": {
                    String targetSessionId = jsonNode.get("target").asText();
                    UserSession targetUser = sessions.get(targetSessionId);
                    if (targetUser != null && targetUser.getSession().isOpen()) {
                        targetUser.getSession().sendMessage(message);
                        logger.info("Forwarded request: {} -> {}", session.getId(), targetSessionId);
                    } else {
                        session.sendMessage(new TextMessage("대상 사용자가 존재하지 않거나 접속이 끊어졌습니다."));
                    }
                    break;
                }

                case "response": {
                    boolean accepted = jsonNode.get("data").get("accepted").asBoolean();
                    String originalSenderSessionId = jsonNode.get("target").asText();
                    UserSession senderUser = sessions.get(originalSenderSessionId);
                    if (senderUser != null && senderUser.getSession().isOpen()) {
                        senderUser.getSession().sendMessage(message);
                        logger.info("Forwarded response: {} -> {}, accepted={}", session.getId(), originalSenderSessionId, accepted);
                        if (accepted) {
                            fileTransferMap.put(originalSenderSessionId, session.getId());
                            logger.info("File transfer mapping: {} -> {}", originalSenderSessionId, session.getId());
                        }
                    } else {
                        session.sendMessage(new TextMessage("요청한 사용자가 접속 중이지 않습니다."));
                    }
                    break;
                }

                case "meta": {
                    // 파일 메타데이터를 수신자에게 전달
                    String metaTargetId = jsonNode.get("target").asText();
                    UserSession metaTargetUser = sessions.get(metaTargetId);
                    if (metaTargetUser != null && metaTargetUser.getSession().isOpen()) {
                        metaTargetUser.getSession().sendMessage(message);
                        logger.info("Forwarded meta to {}", metaTargetId);
                    }
                    break;
                }

                case "complete": {
                    // 파일 단위 complete: 매핑은 유지하고 수신자에게만 전달
                    String completeTargetId = jsonNode.has("target") ? jsonNode.get("target").asText() : null;
                    if (completeTargetId != null) {
                        UserSession completeTargetUser = sessions.get(completeTargetId);
                        if (completeTargetUser != null && completeTargetUser.getSession().isOpen()) {
                            completeTargetUser.getSession().sendMessage(message);
                        }
                    }
                    logger.info("File complete (mapping kept): sender={}", session.getId());
                    break;
                }

                case "allComplete": {
                    // 모든 파일 전송 완료: 매핑 제거 후 수신자에게 전달
                    fileTransferMap.remove(session.getId());
                    logger.info("All files complete: removed mapping for sender={}", session.getId());
                    String allCompleteTargetId = jsonNode.has("target") ? jsonNode.get("target").asText() : null;
                    if (allCompleteTargetId != null) {
                        UserSession allCompleteTargetUser = sessions.get(allCompleteTargetId);
                        if (allCompleteTargetUser != null && allCompleteTargetUser.getSession().isOpen()) {
                            allCompleteTargetUser.getSession().sendMessage(message);
                        }
                    }
                    break;
                }

                default:
                    session.sendMessage(new TextMessage("알 수 없는 메시지 타입입니다."));
                    logger.warn("Unknown message type from {}: {}", session.getId(), type);
            }
        } catch (Exception e) {
            logger.error("Error handling text message from {}: {}", session.getId(), e.getMessage(), e);
            try {
                session.sendMessage(new TextMessage("메시지 처리 중 오류가 발생하였습니다."));
            } catch (Exception sendEx) {
                logger.error("Error sending error message to {}: {}", session.getId(), sendEx.getMessage(), sendEx);
            }
        }
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) throws Exception {
        String senderSessionId = session.getId();

        // 파일 크기 검증
        if (message.getPayloadLength() > MAX_BINARY_SIZE) {
            session.sendMessage(new TextMessage("파일 크기가 100MB를 초과하였습니다."));
            logger.warn("Binary message too large from {}: {} bytes", senderSessionId, message.getPayloadLength());
            return;
        }

        String targetSessionId = fileTransferMap.get(senderSessionId);
        logger.info("Binary message: sender={}, target={}", senderSessionId, targetSessionId);

        if (targetSessionId != null) {
            UserSession targetUser = sessions.get(targetSessionId);
            if (targetUser != null && targetUser.getSession().isOpen()) {
                targetUser.getSession().sendMessage(message);
            } else {
                session.sendMessage(new TextMessage("파일 전송 대상 사용자가 접속 중이지 않습니다."));
                fileTransferMap.remove(senderSessionId);
                logger.warn("Target session {} not available, mapping removed.", targetSessionId);
            }
        } else {
            session.sendMessage(new TextMessage("파일 전송 세션이 설정되어 있지 않습니다."));
            logger.warn("No file transfer mapping for sender {}", senderSessionId);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        logger.info("Connection closed: sessionId={}, status={}", session.getId(), status);
        sessions.remove(session.getId());
        fileTransferMap.remove(session.getId());
        broadcastUserList();
    }
}
