import React, { useState, useEffect, useRef } from "react";
import { Github, HelpCircle } from "lucide-react";

const MAX_CONCURRENT_FILES = 30;
const BLOCKED_EXTENSIONS = ['exe','bat','cmd','sh','ps1','msi','dmg','apk','vbs','jar','com','scr'];

const generateUUID = () =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : ((r & 0x3) | 0x8);
        return v.toString(16);
    });

const App = () => {
    const [currentUser, setCurrentUser] = useState(null);
    const [users, setUsers] = useState([]);
    const [searchTerm, setSearchTerm] = useState("");
    const [showTransferModal, setShowTransferModal] = useState(false);
    const [showWifiAlert, setShowWifiAlert] = useState(false);
    const [selectedFiles, setSelectedFiles] = useState([]);
    const [selectedUser, setSelectedUser] = useState(null);
    const [showContextMenu, setShowContextMenu] = useState(null);
    const [showProfileModal, setShowProfileModal] = useState(false);
    const [modal, setModal] = useState({ visible: false, message: "" });
    const [showFileSelectModal, setShowFileSelectModal] = useState(false);
    const [showInfoModal, setShowInfoModal] = useState(false);
    const [receivedFiles, setReceivedFiles] = useState([]); // 수신 완료된 파일 목록
    const [isSending, setIsSending] = useState(false);      // 전송 중 여부

    const fileInputRef = useRef(null);
    const ws = useRef(null);
    const pendingFileMeta = useRef({});

    const filteredUsers = users.filter((user) =>
        user.nickname.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const addSystemMessage = (message) => {
        console.log("[System Message]:", message);
    };

    const closeWifiAlert = () => {
        setShowWifiAlert(false);
        setSelectedFiles([]);
        setSelectedUser(null);
    };

    const handleUserClick = (user) => {
        setSelectedUser(user);
        if (ws.current && currentUser && currentUser.sessionId) {
            ws.current.send(
                JSON.stringify({
                    type: "request",
                    senderSessionId: currentUser.sessionId,
                    senderNickname: currentUser.nickname,
                    target: user.sessionId,
                })
            );
            setModal({ visible: true, message: "현재 연결중입니다. 잠시만 기다려주세요." });
        }
    };

    useEffect(() => {
        // wss:// / ws:// 자동 선택 + 포트 하드코딩 제거
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = process.env.REACT_APP_WS_URL ||
            `${protocol}//${window.location.host}/ws`;

        ws.current = new WebSocket(wsUrl);
        ws.current.binaryType = "arraybuffer";

        ws.current.onopen = () => {
            addSystemMessage("서버에 연결되었습니다.");
            setModal({ visible: false, message: "" });
        };

        ws.current.onmessage = (event) => {
            if (typeof event.data === "string") {
                try {
                    const data = JSON.parse(event.data);
                    switch (data.type) {
                        case "init":
                            setCurrentUser({
                                id: data.sessionId,
                                nickname: data.nickname,
                                sessionId: data.sessionId,
                                isOnline: true,
                            });
                            break;
                        case "userList":
                            setUsers(data.users);
                            break;
                        case "request":
                            setSelectedUser({
                                id: data.senderSessionId,
                                nickname: data.senderNickname,
                                sessionId: data.senderSessionId,
                            });
                            setShowTransferModal(true);
                            break;
                        case "response":
                            setModal({ visible: false, message: "" });
                            if (data.data.accepted) {
                                addSystemMessage("전송 요청이 수락되었습니다.");
                                setShowFileSelectModal(true);
                            } else {
                                addSystemMessage("전송 요청이 거절되었습니다.");
                                setSelectedUser(null);
                            }
                            break;
                        case "meta":
                            // 다음 binary와 매핑할 파일 정보 저장
                            pendingFileMeta.current[data.fileId] = {
                                fileName: data.fileName,
                                fileType: data.fileType,
                            };
                            break;
                        case "complete":
                            addSystemMessage("파일 수신이 완료되었습니다.");
                            break;
                        case "allComplete":
                            addSystemMessage("모든 파일 수신이 완료되었습니다.");
                            break;
                        default:
                            addSystemMessage("서버 메시지: " + event.data);
                    }
                } catch (err) {
                    addSystemMessage("파싱 오류: " + event.data);
                }
            } else {
                // 바이너리 수신: UUID prefix(36바이트)로 fileId 추출 후 수신 목록에 추가
                const buffer = event.data;
                const headerBytes = new Uint8Array(buffer, 0, 36);
                const fileId = new TextDecoder().decode(headerBytes);
                const fileData = buffer.slice(36);

                const meta = pendingFileMeta.current[fileId];
                const fileName = meta?.fileName || "Netdrops_download";
                const fileType = meta?.fileType || "application/octet-stream";
                if (meta) delete pendingFileMeta.current[fileId];

                const blob = new Blob([fileData], { type: fileType });

                // 자동 다운로드(a.click()) 제거 → 수신 목록에 추가하여 사용자가 직접 저장 (iOS 대응)
                setReceivedFiles((prev) => [...prev, { name: fileName, blob }]);
                addSystemMessage(`파일 수신 완료: ${fileName}`);
            }
        };

        ws.current.onerror = () => {
            addSystemMessage("WebSocket 에러 발생");
        };

        ws.current.onclose = () => {
            addSystemMessage("연결이 종료되었습니다.");
        };

        return () => {
            ws.current && ws.current.close();
        };
    }, []);

    // 파일을 한 개씩 순차 전송 (meta → binary → complete 순서 보장)
    const handleSendFiles = async () => {
        if (!selectedFiles.length || !selectedUser || !ws.current) return;

        // 블랙리스트 검증
        for (const file of selectedFiles) {
            const ext = file.name.split('.').pop().toLowerCase();
            if (BLOCKED_EXTENSIONS.includes(ext)) {
                alert(`${file.name}: 실행 파일은 전송할 수 없습니다.`);
                return;
            }
        }

        const targetSessionId = selectedUser.sessionId;
        setIsSending(true);
        setShowFileSelectModal(false);

        for (const file of selectedFiles) {
            const fileId = generateUUID();

            // 1. meta 전송
            ws.current.send(JSON.stringify({
                type: "meta",
                fileId,
                fileName: file.name,
                fileType: file.type || "application/octet-stream",
                target: targetSessionId,
            }));

            // 2. binary 전송: await로 읽기 완료 후 즉시 전송 → meta 이후 순서 보장
            const arrayBuffer = await file.arrayBuffer();
            const header = new TextEncoder().encode(fileId);
            const payload = new Uint8Array(header.length + arrayBuffer.byteLength);
            payload.set(header, 0);
            payload.set(new Uint8Array(arrayBuffer), header.length);
            ws.current.send(payload.buffer);

            // 3. 파일 단위 complete
            ws.current.send(JSON.stringify({
                type: "complete",
                target: targetSessionId,
                fileId,
            }));

            addSystemMessage(`파일 전송됨: ${file.name}`);
        }

        // 4. 모든 파일 전송 완료 → 서버 매핑 해제
        ws.current.send(JSON.stringify({
            type: "allComplete",
            target: targetSessionId,
        }));

        setIsSending(false);
        setSelectedFiles([]);
        setSelectedUser(null);
    };

    const handleFileSelect = (e) => {
        const files = e.target.files;
        if (!files) return;
        const filesArray = Array.from(files);
        if (filesArray.length > MAX_CONCURRENT_FILES) {
            alert("최대 30개까지 선택 가능합니다.");
            return;
        }
        setSelectedFiles(filesArray);
        setShowFileSelectModal(false);
    };

    const handleTransferResponse = (accepted) => {
        if (ws.current && selectedUser && currentUser) {
            ws.current.send(JSON.stringify({
                type: "response",
                data: { accepted },
                target: selectedUser.sessionId,
                from: currentUser.sessionId, // 수락자 sessionId 포함
            }));
        }
        setShowTransferModal(false);
        if (!accepted) setSelectedUser(null);
    };

    const clearSearch = () => setSearchTerm("");

    const handleSaveFile = (file) => {
        const url = URL.createObjectURL(file.blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    return (
        <div className="min-h-screen bg-transparent flex flex-col">
            {/* 연결 안내 모달 */}
            {modal.visible && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-30">
                    <div className="bg-white rounded-lg p-6 max-w-md w-full text-center">
                        <p className="text-lg font-semibold">{modal.message}</p>
                        <button
                            className="mt-4 px-4 py-2 bg-blue-500 text-white rounded"
                            onClick={() => setModal({ visible: false, message: "" })}
                        >
                            확인
                        </button>
                    </div>
                </div>
            )}

            <div className="fixed top-8 left-8 z-40 flex items-baseline space-x-4">
                <h1 className="text-3xl font-bold text-black">Netdrops</h1>
                <a
                    href="https://github.com/NetDrops/NetDrops"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:opacity-80"
                >
                    <Github className="w-6 h-6 relative top-1 text-gray-700" />
                </a>
                <button onClick={() => setShowInfoModal(true)} className="hover:opacity-80">
                    <HelpCircle className="w-6 h-6 relative top-1 text-gray-700" />
                </button>
            </div>

            {/* 서비스 정보 모달 */}
            {showInfoModal && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                    <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
                        <h2 className="text-xl font-semibold mb-4">Netdrops 소개</h2>
                        <p className="text-gray-700 mb-4">
                            Netdrops는 같은 네트워크 상의 사용자끼리 빠르고 간편하게
                            파일을 공유할 수 있는 WebSocket 기반 P2P 파일 전송 서비스입니다.
                        </p>
                        <button
                            onClick={() => setShowInfoModal(false)}
                            className="mt-2 px-4 py-2 bg-primary text-white rounded-md hover:bg-blue-600"
                        >
                            닫기
                        </button>
                    </div>
                </div>
            )}

            {/* 메인 콘텐츠 */}
            <div className="flex flex-col items-center justify-center min-h-screen pt-20 pb-32">
                {currentUser && currentUser.sessionId && (
                    <div className="max-w-md w-full px-4 mb-4 text-center text-lg font-semibold text-gray-700">
                        ID: {currentUser.nickname}
                        {currentUser.isOnline ? (
                            <span className="inline-flex items-center ml-2">
                                <span className="text-blue-500">접속중</span>
                                <div className="ml-3 animate-spin rounded-full h-4 w-4 border-2 border-gray-200 border-t-blue-500"></div>
                            </span>
                        ) : (
                            <span className="ml-2 text-gray-500">오프라인</span>
                        )}
                    </div>
                )}

                <section className="bg-white rounded-xl p-8 shadow-subtle text-center mb-8 max-w-xl">
                    <p className="text-gray-600 text-lg">
                        Netdrops는 쉽고 빠르게 파일을 전송할 수 있는 서비스입니다.
                        <br />
                        같은 네트워크의 사용자와 간편하게 공유하세요.
                    </p>
                </section>

                {/* 검색 */}
                <div className="max-w-md w-full mb-6">
                    <div className="relative">
                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                            <i className="fas fa-search text-gray-400"></i>
                        </div>
                        <input
                            type="text"
                            className="block w-full pl-10 pr-10 py-2 border border-gray-300 rounded-full focus:ring-primary focus:border-primary text-sm"
                            placeholder="전송하고자 하는 디바이스의 닉네임을 검색해주세요."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                        {searchTerm && (
                            <button
                                className="absolute inset-y-0 right-0 pr-3 flex items-center cursor-pointer"
                                onClick={clearSearch}
                            >
                                <i className="fas fa-times text-gray-400"></i>
                            </button>
                        )}
                    </div>
                </div>

                {/* 사용자 목록 */}
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-8">
                    {filteredUsers.filter(u => u.sessionId !== currentUser?.sessionId).length === 0
                        ? "No users connected."
                        : filteredUsers
                            .filter((u) => u.sessionId !== currentUser?.sessionId)
                            .map((user) => (
                                <div
                                    key={user.sessionId}
                                    className="bg-white rounded-xl p-4 shadow-subtle hover:shadow-md transition transform hover:-translate-y-1 text-center cursor-pointer"
                                    onClick={() => handleUserClick(user)}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        setSelectedUser(user);
                                        setShowContextMenu({ x: e.clientX, y: e.clientY });
                                    }}
                                >
                                    <div className="w-16 h-16 mx-auto bg-primary rounded-full flex items-center justify-center text-white text-xl font-bold mb-2">
                                        {user.nickname.charAt(0).toUpperCase()}
                                    </div>
                                    <div className="text-sm font-medium truncate">{user.nickname}</div>
                                </div>
                            ))}
                </div>
            </div>

            {/* 수신된 파일 목록 (하단 고정) - 사용자가 직접 탭하여 저장 (iOS 대응) */}
            {receivedFiles.length > 0 && (
                <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg p-4 z-20">
                    <div className="max-w-xl mx-auto">
                        <div className="flex justify-between items-center mb-2">
                            <h4 className="font-semibold text-sm">수신된 파일 ({receivedFiles.length})</h4>
                            <button
                                className="text-xs text-gray-400 hover:text-gray-600"
                                onClick={() => setReceivedFiles([])}
                            >
                                모두 지우기
                            </button>
                        </div>
                        <div className="flex flex-col gap-2 max-h-40 overflow-y-auto">
                            {receivedFiles.map((file, i) => (
                                <div key={i} className="flex justify-between items-center bg-gray-50 rounded px-3 py-2">
                                    <span className="text-sm truncate flex-1 mr-4">{file.name}</span>
                                    <button
                                        className="flex-shrink-0 px-3 py-1 bg-blue-500 text-white text-sm rounded hover:bg-blue-600"
                                        onClick={() => handleSaveFile(file)}
                                    >
                                        저장하기
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* 숨김 파일 입력 */}
            <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                multiple
                onChange={handleFileSelect}
            />

            {/* 파일 선택 모달 */}
            {showFileSelectModal && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-30">
                    <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl text-center">
                        <h3 className="text-lg font-semibold mb-4">파일 선택</h3>
                        <p className="mb-4 text-sm text-gray-500">전송할 파일을 선택해주세요.</p>
                        <button
                            className="px-4 py-2 bg-blue-500 text-white rounded"
                            onClick={() => {
                                fileInputRef.current && fileInputRef.current.click();
                                setShowFileSelectModal(false);
                            }}
                        >
                            파일 선택하기
                        </button>
                        <div className="mt-4">
                            <button
                                className="text-sm text-blue-500 underline"
                                onClick={() => {
                                    setShowFileSelectModal(false);
                                    setSelectedUser(null);
                                }}
                            >
                                닫기
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 파일 전송 확인 모달 */}
            {selectedFiles.length > 0 && selectedUser && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-30">
                    <div className="bg-white rounded-lg p-6 max-w-xl w-full mx-4">
                        <h3 className="text-lg font-semibold mb-4">
                            {selectedUser.nickname}에게 전송
                        </h3>
                        <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 mb-4">
                            <div className="text-sm mb-2 text-gray-500">
                                {selectedFiles.length}개 파일 선택됨 (최대 30개)
                            </div>
                            <div className="flex overflow-x-auto pb-2 gap-2">
                                {selectedFiles.map((file, index) => (
                                    <div key={index} className="flex-shrink-0 w-16 h-16 bg-gray-100 rounded overflow-hidden">
                                        {file.type.startsWith("image/") ? (
                                            <img
                                                src={URL.createObjectURL(file)}
                                                alt={file.name}
                                                className="w-full h-full object-cover"
                                            />
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center text-xs text-gray-600 font-bold p-1 text-center">
                                                {file.name.split('.').pop().toUpperCase()}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                        {isSending && (
                            <p className="text-sm text-blue-500 mb-3 text-center">전송 중...</p>
                        )}
                        <div className="flex justify-end gap-3">
                            <button
                                onClick={() => {
                                    setSelectedFiles([]);
                                    setSelectedUser(null);
                                }}
                                disabled={isSending}
                                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                            >
                                취소
                            </button>
                            <button
                                onClick={handleSendFiles}
                                disabled={isSending}
                                className="px-4 py-2 bg-primary text-white rounded-md hover:bg-blue-600 disabled:opacity-50"
                            >
                                전송하기
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 파일 전송 요청 모달 (수신자 측) */}
            {showTransferModal && selectedUser && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-30">
                    <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
                        <div className="text-center mb-4">
                            <div className="w-16 h-16 mx-auto bg-primary rounded-full flex items-center justify-center text-white text-xl font-bold mb-3">
                                {selectedUser.nickname.charAt(0).toUpperCase()}
                            </div>
                            <h3 className="text-lg font-semibold">파일 전송 요청</h3>
                            <p className="text-gray-600 mt-1">
                                {selectedUser.nickname}님이 전송을 요청했어요.
                            </p>
                        </div>
                        <div className="flex justify-center gap-3 mt-6">
                            <button
                                onClick={() => handleTransferResponse(false)}
                                className="px-5 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
                            >
                                거절하기
                            </button>
                            <button
                                onClick={() => handleTransferResponse(true)}
                                className="px-5 py-2 bg-primary text-white rounded-md hover:bg-blue-600"
                            >
                                수락하기
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 우클릭 컨텍스트 메뉴 */}
            {showContextMenu && selectedUser && (
                <div
                    className="fixed bg-white rounded-lg shadow-xl py-2 z-30"
                    style={{
                        top: showContextMenu.y,
                        left: showContextMenu.x,
                        transform: "translate(-50%, -50%)",
                    }}
                >
                    <button
                        className="w-full px-4 py-2 text-left hover:bg-gray-100 text-sm rounded"
                        onClick={() => {
                            fileInputRef.current && fileInputRef.current.click();
                            setShowContextMenu(null);
                        }}
                    >
                        <i className="fas fa-file-upload mr-2"></i>파일 전송
                    </button>
                    <button
                        className="w-full px-4 py-2 text-left hover:bg-gray-100 text-sm rounded"
                        onClick={() => {
                            setShowProfileModal(true);
                            setShowContextMenu(null);
                        }}
                    >
                        <i className="fas fa-user mr-2"></i>프로필 보기
                    </button>
                </div>
            )}

            {/* 프로필 모달 */}
            {showProfileModal && selectedUser && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-30">
                    <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl">
                        <div className="text-center mb-6">
                            <div className="w-24 h-24 mx-auto bg-primary rounded-full flex items-center justify-center text-white text-3xl font-bold mb-4">
                                {selectedUser.nickname.charAt(0).toUpperCase()}
                            </div>
                            <h3 className="text-xl font-semibold">{selectedUser.nickname}</h3>
                            <p className="text-gray-600 mt-2">ID: {selectedUser.id}</p>
                        </div>
                        <div className="flex justify-center gap-3">
                            <button
                                onClick={() => {
                                    fileInputRef.current && fileInputRef.current.click();
                                    setShowProfileModal(false);
                                }}
                                className="px-4 py-2 bg-primary text-white rounded-md hover:bg-blue-600"
                            >
                                파일 전송
                            </button>
                            <button
                                onClick={() => setShowProfileModal(false)}
                                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
                            >
                                닫기
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* WiFi Alert Modal */}
            {showWifiAlert && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-30">
                    <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl text-center">
                        <div className="w-16 h-16 mx-auto bg-yellow-500 rounded-full flex items-center justify-center text-white text-xl font-bold mb-3">
                            <i className="fas fa-wifi"></i>
                        </div>
                        <h3 className="text-lg font-semibold">네트워크 연결 오류</h3>
                        <p className="text-gray-600 mt-2">
                            같은 wifi에 연결되어 있지 않아요. 같은 wifi에 접속해주세요.
                        </p>
                        <div className="flex justify-center mt-6">
                            <button
                                onClick={closeWifiAlert}
                                className="px-5 py-2 bg-primary text-white rounded-md hover:bg-blue-600"
                            >
                                확인
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default App;
