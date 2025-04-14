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

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.List;
import java.util.stream.Collectors;

public class MainSocketHandler extends BinaryWebSocketHandler {

    private static final Logger logger = LoggerFactory.getLogger(MainSocketHandler.class);

    // 사용자 세션 관리: sessionId -> UserSession
    private final Map<String, UserSession> sessions = new ConcurrentHashMap<>();
    // 다중 파일 전송 매핑: senderSessionId -> Map(fileId -> targetSessionId)
    private final Map<String, Map<String, String>> multiFileTransferMap = new ConcurrentHashMap<>();
    // 최대 동시 파일 전송 수 (sender당)
    private static final int MAX_CONCURRENT_FILES = 30;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        String randomNickname = NicknameGenerator.generate();
        UserSession userSession = new UserSession(session.getId(), randomNickname, session);
        sessions.put(session.getId(), userSession);
        logger.info("New connection established: sessionId={}, nickname={}", session.getId(), randomNickname);

        //start init
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
                    String targetSessionId = jsonNode.get("target").asText();
                    UserSession requestSenderUser = sessions.get(session.getId());
                    UserSession targetUser = sessions.get(targetSessionId);

                    if (targetUser != null && targetUser.getSession().isOpen() &&
                            requestSenderUser != null && requestSenderUser.getSession().isOpen()) {

                        if (targetUser.isBusy() || requestSenderUser.isBusy()) {
                            session.sendMessage(new TextMessage("현재 연결중입니다. 잠시만 기다려주세요."));
                            logger.info("Either sender {} or target {} is busy.", session.getId(), targetSessionId);
                            return;
                        }
                        requestSenderUser.setBusy(true);
                        targetUser.setBusy(true);

                        targetUser.getSession().sendMessage(message);
                        logger.info("Forwarded request message from {} to {} (both set to busy)", session.getId(), targetSessionId);
                    } else {
                        session.sendMessage(new TextMessage("대상 사용자가 존재하지 않거나 접속이 끊어졌습니다."));
                    }
                    break;

                case "response":
                    boolean accepted = jsonNode.get("data").get("accepted").asBoolean();
                    String originalSenderSessionId = jsonNode.get("target").asText();
                    UserSession senderUser = sessions.get(originalSenderSessionId);
                    UserSession responderUser = sessions.get(session.getId());

                    if (senderUser != null && senderUser.getSession().isOpen() &&
                            responderUser != null && responderUser.getSession().isOpen()) {

                        senderUser.getSession().sendMessage(message);
                        logger.info("Forwarded response message from {} to {}: accepted={}", session.getId(), originalSenderSessionId, accepted);
                        if (accepted) {
                            multiFileTransferMap.putIfAbsent(originalSenderSessionId, new ConcurrentHashMap<>());
                            logger.info("Prepared multi-file transfer mapping for sender {}", originalSenderSessionId);
                        } else {
                            senderUser.setBusy(false);
                            responderUser.setBusy(false);
                            logger.info("Cleared busy status for sender {} and responder {} due to rejection", originalSenderSessionId, session.getId());
                        }
                    } else {
                        session.sendMessage(new TextMessage("요청한 사용자가 접속 중이지 않습니다."));
                    }
                    break;


                case "meta":
                    String fileId = jsonNode.get("fileId").asText();
                    String metaTargetId = jsonNode.get("target").asText();
                    Map<String, String> senderFiles = multiFileTransferMap.computeIfAbsent(session.getId(), key -> new ConcurrentHashMap<>());

                    if (senderFiles.size() >= MAX_CONCURRENT_FILES) {
                        session.sendMessage(new TextMessage("동시 전송 가능한 파일 수(최대 " + MAX_CONCURRENT_FILES + "개)를 초과하였습니다."));
                        logger.info("Sender {} exceeded maximum concurrent file transfers.", session.getId());
                        return;
                    }

                    senderFiles.put(fileId, metaTargetId);
                    break;

                default:
                    session.sendMessage(new TextMessage("who are you" + type));
            }
        } catch (Exception e) {
            logger.error("Error handling text {}: {}", session.getId(), e.getMessage(), e);
            try {
                session.sendMessage(new TextMessage("메시지 처리 중 오류 발생: " + e.getMessage()));
            } catch (Exception sendEx) {
                logger.error("Error sending error message to {}: {}", session.getId(), sendEx.getMessage(), sendEx);
            }
        }
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) throws Exception {
        ByteBuffer buffer = message.getPayload();

        if (buffer.remaining() < 36) {
            session.sendMessage(new TextMessage("파일 전송 데이터 오류: 파일 ID 정보 부족"));
            return;
        }

        byte[] idBytes = new byte[36];
        buffer.get(idBytes, 0, 36);
        String fileId = new String(idBytes, StandardCharsets.UTF_8);
        ByteBuffer fileDataBuffer = buffer.slice();
        BinaryMessage fileDataMessage = new BinaryMessage(fileDataBuffer);

        Map<String, String> senderFiles = multiFileTransferMap.get(session.getId());
        if (senderFiles != null) {
            String targetSessionId = senderFiles.get(fileId);
            logger.info("handleBinaryMessage: sender={}, fileId={}, target={}", session.getId(), fileId, targetSessionId);
            if (targetSessionId != null) {
                UserSession targetUser = sessions.get(targetSessionId);
                if (targetUser != null && targetUser.getSession().isOpen()) {
                    logger.info("Forwarding binary message for file {} from {} to target {}", fileId, session.getId(), targetSessionId);
                    targetUser.getSession().sendMessage(fileDataMessage);
                } else {
                    session.sendMessage(new TextMessage("파일 전송 대상 사용자가 접속 중이지 않습니다."));
                    logger.info("Failed to forward binary message: target session {} not available.", targetSessionId);
                }
                // 전송 완료 후 해당 fileId 매핑 제거
                senderFiles.remove(fileId);
                logger.info("Removed file transfer mapping for fileId {} from sender {}", fileId, session.getId());

                if (senderFiles.isEmpty()) {
                    // 해제: 송신자 busy 상태
                    UserSession senderSession = sessions.get(session.getId());
                    if (senderSession != null) {
                        senderSession.setBusy(false);
                        logger.info("Cleared busy status for sender {}", session.getId());
                    }
                    // 해제: 수신자 busy 상태
                    UserSession receiverSession = sessions.get(targetSessionId);
                    if (receiverSession != null) {
                        receiverSession.setBusy(false);
                        logger.info("Cleared busy status for receiver {}", targetSessionId);
                    }
                }
            } else {
                session.sendMessage(new TextMessage("파일 전송 매핑 정보가 없습니다."));
                logger.info("No file transfer mapping found for fileId {} from sender {}", fileId, session.getId());
            }
        } else {
            session.sendMessage(new TextMessage("파일 전송 세션이 설정되어 있지 않습니다."));
            logger.info("No multi-file transfer mapping found for sender {}", session.getId());
        }
    }


    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        logger.info("Connection closed: sessionId={}, status={}", session.getId(), status);
        sessions.remove(session.getId());
        multiFileTransferMap.remove(session.getId());
        broadcastUserList();
    }
}
