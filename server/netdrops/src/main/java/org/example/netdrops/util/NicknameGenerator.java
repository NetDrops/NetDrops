package org.example.netdrops.util;

import java.util.List;
import java.util.Random;

public class NicknameGenerator {
    private static final List<String> ADJECTIVES = List.of("익명", "귀여운", "멋진", "용감한", "조용한");
    private static final List<String> ANIMALS = List.of("토끼", "고양이", "강아지", "사슴", "너구리", "곰", "다람쥐");
    private static final Random RANDOM = new Random();

    public static String generate() {
        String adjective = ADJECTIVES.get(RANDOM.nextInt(ADJECTIVES.size()));
        String animal = ANIMALS.get(RANDOM.nextInt(ANIMALS.size()));
        return adjective + " " + animal;
    }
}
