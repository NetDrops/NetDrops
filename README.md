<p align="center">
  <h1 align="center">Netdrops</h1>
  <p align="center">
    디바이스 제약 없이 빠르고 간편하게 파일을 공유하세요
    <br />
    설치 없이 브라우저만으로 사용하는 WebSocket 기반 파일 전송 서비스
  </p>
</p>

<p align="center">
  <a href="https://netdrops.cloud"><img src="https://img.shields.io/badge/Live-netdrops.cloud-007aff?style=flat-square&logo=googlechrome&logoColor=white" /></a>
  <img src="https://img.shields.io/badge/Java-21-007396?style=flat-square&logo=openjdk&logoColor=white" />
  <img src="https://img.shields.io/badge/Spring_Boot-3.4.4-6DB33F?style=flat-square&logo=springboot&logoColor=white" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" />
  <img src="https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white" />
</p>

---

## Overview

**Netdrops**는 같은 네트워크에 있지 않아도 브라우저만 열면 누구든 파일을 주고받을 수 있는 서비스입니다.

Apple AirDrop이 타 OS 디바이스와 연동되지 않는 문제를 해결하기 위한 브라우저 기반 크로스 플랫폼 파일 전송 서비스입니다.

(2026년 3월 26일부로 일부 Android 기기(Galaxy S26)의 퀵 셰어에서 AirDrop 호환이 지원됩니다.)

> **개발 기간** : 2025.04 ~ 운영 중

## Features

- **크로스 플랫폼** — Windows, Mac, iOS, Android 어디서든 브라우저로 접속
- **원본 전송** — 압축 없이 원본 파일 그대로 전달
- **설치 X** — 앱 설치 없이 URL 접속만으로 사용
- **실시간 연결** — WebSocket 기반 실시간 사용자 탐색 및 파일 전송
- **보안** — 서버에 파일을 저장하지 않고 실시간 릴레이 방식으로 전달

## Architecture
![Architecture](/images/Architecture.png)

1. 접속하면 고유 닉네임이 부여되고, 접속 중인 사용자 목록이 표시됩니다.
2. 상대방을 클릭하면 전송 요청이 전달됩니다.
3. 상대방이 수락하면 파일을 선택하여 전송합니다.
4. 수신자는 하단 바에서 파일을 저장합니다.

## Tech Stack

![Java 21](https://img.shields.io/badge/Java_21-ED8B00?style=for-the-badge&logo=openjdk&logoColor=white)
![Spring Boot](https://img.shields.io/badge/Spring_Boot-6DB33F?style=for-the-badge&logo=springboot&logoColor=white)
![WebSocket](https://img.shields.io/badge/WebSocket-010101?style=for-the-badge&logo=socketdotio&logoColor=white)
![React 19](https://img.shields.io/badge/React_19-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Nginx](https://img.shields.io/badge/Nginx-009639?style=for-the-badge&logo=nginx&logoColor=white)
![Raspberry Pi](https://img.shields.io/badge/Raspberry_Pi-A22846?style=for-the-badge&logo=raspberrypi&logoColor=white)
## Contributing

기여를 환영합니다! 버그 리포트, 기능 제안, PR 모두 열려 있습니다.

1. 이 레포지토리를 Fork합니다.
2. 새 브랜치를 생성합니다. (`git checkout -b feat/my-feature`)
3. 변경사항을 커밋합니다. (`git commit -m "feat: add my feature"`)
4. 브랜치에 Push합니다. (`git push origin feat/my-feature`)
5. Pull Request를 생성합니다.

## License

This project is licensed under the MIT License.
