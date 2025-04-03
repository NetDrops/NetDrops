package org.example.netdrops.handler;

import org.example.netdrops.model.UserSession;
import org.example.netdrops.util.IpUtils;
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
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.List;
import java.util.stream.Collectors;

public class MainSocketHandler extends BinaryWebSocketHandler {

    private static final Logger logger = LoggerFactory.getLogger(MainSocketHandler.class);

    // 사용자 세션 관리: sessionId -> UserSession (UserSession 내부에 WebSocketSession 포함)
    private final Map<String, UserSession> sessions = new ConcurrentHashMap<>();
    // 파일 전송 시, 전송 요청을 수락한 후 senderSessionId -> targetSessionId 매핑
    private final Map<String, String> fileTransferMap = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        String randomNickname = NicknameGenerator.generate();
        UserSession userSession = new UserSession(session.getId(), randomNickname, session);
        sessions.put(session.getId(), userSession);
        logger.info("New connection established: sessionId={}, nickname={}", session.getId(), randomNickname);

        // init 메시지 전송
        try {
            String initMsg = objectMapper.writeValueAsString(
                    Map.of("type", "init", "sessionId", session.getId(), "nickname", randomNickname)
            );
            session.sendMessage(new TextMessage(initMsg));
            logger.info("Sent init message to session {}: {}", session.getId(), initMsg);
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
            logger.info("Broadcasting user list: {}", message);
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
        logger.info("Received text message from {}: {}", session.getId(), payload);

        try {
            JsonNode jsonNode = objectMapper.readTree(payload);
            String type = jsonNode.get("type").asText();

            switch (type) {
                case "request":
                    // A가 B에게 전송 요청 (메타데이터 포함)
                    String targetSessionId = jsonNode.get("target").asText();
                    UserSession targetUser = sessions.get(targetSessionId);
                    if (targetUser != null && targetUser.getSession().isOpen()) {
                        // 같은 서브넷 체크 (선택 사항)
                        if (IpUtils.isSameSubnet(session.getRemoteAddress(), targetUser.getSession().getRemoteAddress())) {
                            targetUser.getSession().sendMessage(message);
                            logger.info("Forwarded request message from {} to {}", session.getId(), targetSessionId);
                        } else {
                            session.sendMessage(new TextMessage("상대방과 같은 서브넷에 있지 않아 전송할 수 없습니다."));
                            logger.info("Failed to forward request: different subnet. Sender: {}, Target: {}", session.getId(), targetSessionId);
                        }
                    } else {
                        session.sendMessage(new TextMessage("대상 사용자가 존재하지 않거나 접속이 끊어졌습니다."));
                        logger.info("Failed to forward request: target session {} not available.", targetSessionId);
                    }
                    break;

                case "response":
                    // B가 A의 전송 요청에 대한 수락/거절 응답
                    boolean accepted = jsonNode.get("data").get("accepted").asBoolean();
                    String originalSenderSessionId = jsonNode.get("target").asText();
                    UserSession senderUser = sessions.get(originalSenderSessionId);
                    if (senderUser != null && senderUser.getSession().isOpen()) {
                        senderUser.getSession().sendMessage(message);
                        logger.info("Forwarded response message from {} to {}: accepted={}", session.getId(), originalSenderSessionId, accepted);
                        if (accepted) {
                            fileTransferMap.put(originalSenderSessionId, session.getId());
                            logger.info("File transfer mapping added: {} -> {}", originalSenderSessionId, session.getId());
                        }
                    } else {
                        session.sendMessage(new TextMessage("요청한 사용자가 접속 중이지 않습니다."));
                        logger.info("Failed to forward response: sender session {} not available.", originalSenderSessionId);
                    }
                    break;

                case "meta":
                    // 파일 메타데이터 전달
                    String metaTargetId = jsonNode.get("target").asText();
                    UserSession metaTargetUser = sessions.get(metaTargetId);
                    if (metaTargetUser != null && metaTargetUser.getSession().isOpen()) {
                        metaTargetUser.getSession().sendMessage(message);
                        logger.info("Forwarded meta message to target {}", metaTargetId);
                    }
                    break;

                default:
                    session.sendMessage(new TextMessage("알 수 없는 메시지 타입: " + type));
                    logger.info("Received unknown message type from {}: {}", session.getId(), type);
            }
        } catch (Exception e) {
            logger.error("Error handling text message from {}: {}", session.getId(), e.getMessage(), e);
            try {
                session.sendMessage(new TextMessage("메시지 처리 중 오류 발생: " + e.getMessage()));
            } catch (Exception sendEx) {
                logger.error("Error sending error message to {}: {}", session.getId(), sendEx.getMessage(), sendEx);
            }
        }
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) throws Exception {
        String senderSessionId = session.getId();
        String targetSessionId = fileTransferMap.get(senderSessionId);
        logger.info("handleBinaryMessage: sender={}, target={}", senderSessionId, targetSessionId);
        if (targetSessionId != null) {
            UserSession targetUser = sessions.get(targetSessionId);
            if (targetUser != null && targetUser.getSession().isOpen()) {
                logger.info("Forwarding binary message from {} to target {}", senderSessionId, targetSessionId);
                targetUser.getSession().sendMessage(message);
            } else {
                session.sendMessage(new TextMessage("파일 전송 대상 사용자가 접속 중이지 않습니다."));
                logger.info("Failed to forward binary message: target session {} not available.", targetSessionId);
            }
            fileTransferMap.remove(senderSessionId);
            logger.info("Removed file transfer mapping for sender {}", senderSessionId);
        } else {
            session.sendMessage(new TextMessage("파일 전송 세션이 설정되어 있지 않습니다."));
            logger.info("No file transfer mapping found for sender {}", senderSessionId);
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

