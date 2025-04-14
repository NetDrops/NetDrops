package org.example.netdrops.model;

import lombok.Getter;
import org.springframework.web.socket.WebSocketSession;
import java.util.concurrent.atomic.AtomicBoolean;

@Getter
public class UserSession {
    private final String sessionId;
    private final String nickname;
    private final WebSocketSession session;
    private final AtomicBoolean busy;

    public UserSession(String sessionId, String nickname, WebSocketSession session) {
        this.sessionId = sessionId;
        this.nickname = nickname;
        this.session = session;
        this.busy = new AtomicBoolean(false);
    }


    public boolean isBusy() {
        return busy.get();
    }

    public void setBusy(boolean busy) {
        this.busy.set(busy);
    }
}
