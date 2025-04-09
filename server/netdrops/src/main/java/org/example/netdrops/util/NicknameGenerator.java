package org.example.netdrops.util;
import java.util.UUID;
public class NicknameGenerator {

    public static String generate() {
        String nickName = "익명_" + UUID.randomUUID().toString().substring(0, 5);
        return nickName;
    }
}


