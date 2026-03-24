package org.example.netdrops.util;

import java.util.UUID;

public class NicknameGenerator {
    public static String generate() {
        String shortId = UUID.randomUUID().toString().replace("-", "").substring(0, 6);
        return "익명_" + shortId;
    }
}
