package org.example.netdrops.model;

import org.springframework.web.socket.WebSocketSession;

public class UserSession {
    private final String sessionId;
    private final String nickname;
    private final WebSocketSession session;

    public UserSession(String sessionId, String nickname, WebSocketSession session) {
        this.sessionId = sessionId;
        this.nickname = nickname;
        this.session = session;
    }

    public String getSessionId() {
        return sessionId;
    }

    public String getNickname() {
        return nickname;
    }

    public WebSocketSession getSession() {
        return session;
    }
}
