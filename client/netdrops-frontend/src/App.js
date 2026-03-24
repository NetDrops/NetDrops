import React, { useState, useEffect, useRef } from "react";
import { Github, HelpCircle } from "lucide-react";

const BLOCKED_EXTENSIONS = ['exe','bat','cmd','sh','ps1','msi','dmg','apk','vbs','jar','com','scr'];

const App = () => {
    const [currentUser, setCurrentUser] = useState(null);
    const [users, setUsers] = useState([]);
    const [searchTerm, setSearchTerm] = useState("");
    const [showTransferModal, setShowTransferModal] = useState(false);
    const [selectedFile, setSelectedFile] = useState(null);
    const [selectedUser, setSelectedUser] = useState(null);
    const [showContextMenu, setShowContextMenu] = useState(null);
    const [showProfileModal, setShowProfileModal] = useState(false);
    const [modal, setModal] = useState({ visible: false, message: "" });
    const [showFileSelectModal, setShowFileSelectModal] = useState(false);
    const [showInfoModal, setShowInfoModal] = useState(false);
    const [receivedFile, setReceivedFile] = useState(null);
    const [isSending, setIsSending] = useState(false);

    const fileInputRef = useRef(null);
    const ws = useRef(null);
    const pendingMeta = useRef(null);

    const filteredUsers = users.filter((user) =>
        user.nickname.toLowerCase().includes(searchTerm.toLowerCase())
    );

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
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = process.env.REACT_APP_WS_URL ||
            `${protocol}//${window.location.host}/ws`;

        ws.current = new WebSocket(wsUrl);
        ws.current.binaryType = "arraybuffer";

        ws.current.onopen = () => {
            console.log("서버에 연결되었습니다.");
            setModal({ visible: false, message: "" });
        };

        ws.current.onmessage = (event) => {
            if (typeof event.data === "string") {
                try {
                    const data = JSON.parse(event.data);
                    switch (data.type) {
                        case "init":
                            setCurrentUser({
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
                                nickname: data.senderNickname,
                                sessionId: data.senderSessionId,
                            });
                            setShowTransferModal(true);
                            break;
                        case "response":
                            setModal({ visible: false, message: "" });
                            if (data.data.accepted) {
                                setShowFileSelectModal(true);
                            } else {
                                setSelectedUser(null);
                            }
                            break;
                        case "meta":
                            pendingMeta.current = {
                                fileName: data.fileName,
                                fileType: data.fileType,
                            };
                            break;
                        case "complete":
                            console.log("파일 수신 완료");
                            break;
                        default:
                            break;
                    }
                } catch (err) {
                    console.error("파싱 오류:", err);
                }
            } else {
                const buffer = event.data;
                const meta = pendingMeta.current;
                const fileName = meta?.fileName || "Netdrops_download";
                const fileType = meta?.fileType || "application/octet-stream";
                pendingMeta.current = null;

                const blob = new Blob([buffer], { type: fileType });
                setReceivedFile({ name: fileName, blob });
            }
        };

        ws.current.onerror = () => console.error("WebSocket 에러 발생");
        ws.current.onclose = () => console.log("연결이 종료되었습니다.");

        return () => {
            if (ws.current) ws.current.close();
        };
    }, []);

    const handleSendFile = async () => {
        if (!selectedFile || !selectedUser || !ws.current) return;

        const ext = selectedFile.name.split('.').pop().toLowerCase();
        if (BLOCKED_EXTENSIONS.includes(ext)) {
            alert(`${selectedFile.name}: 실행 파일은 전송할 수 없습니다.`);
            return;
        }

        const targetSessionId = selectedUser.sessionId;
        setIsSending(true);

        // 1. meta
        ws.current.send(JSON.stringify({
            type: "meta",
            fileName: selectedFile.name,
            fileType: selectedFile.type || "application/octet-stream",
            target: targetSessionId,
        }));

        // 2. binary
        const arrayBuffer = await selectedFile.arrayBuffer();
        ws.current.send(arrayBuffer);

        // 3. complete
        ws.current.send(JSON.stringify({
            type: "complete",
            target: targetSessionId,
        }));

        setIsSending(false);
        setSelectedFile(null);
        setSelectedUser(null);
    };

    const handleFileSelect = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setSelectedFile(file);
        setShowFileSelectModal(false);
    };

    const handleTransferResponse = (accepted) => {
        if (ws.current && selectedUser && currentUser) {
            ws.current.send(JSON.stringify({
                type: "response",
                data: { accepted },
                target: selectedUser.sessionId,
                from: currentUser.sessionId,
            }));
        }
        setShowTransferModal(false);
        if (!accepted) setSelectedUser(null);
    };

    const handleSaveFile = async () => {
        if (!receivedFile) return;

        // 모바일 공유 API 지원 시 (iOS/Android)
        if (navigator.share && navigator.canShare) {
            try {
                const file = new File([receivedFile.blob], receivedFile.name, { type: receivedFile.blob.type });
                if (navigator.canShare({ files: [file] })) {
                    await navigator.share({ files: [file] });
                    return;
                }
            } catch (e) {
                if (e.name === "AbortError") return;
            }
        }

        // 데스크탑 fallback
        const url = URL.createObjectURL(receivedFile.blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = receivedFile.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
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
                            파일을 공유할 수 있는 WebSocket 기반 파일 전송 서비스입니다.
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
                                onClick={() => setSearchTerm("")}
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

            {/* 수신된 파일 (하단 고정) */}
            {receivedFile && (
                <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg p-4 z-20">
                    <div className="max-w-xl mx-auto">
                        <div className="flex justify-between items-center">
                            <span className="text-sm truncate flex-1 mr-4">{receivedFile.name}</span>
                            <div className="flex gap-2">
                                <button
                                    className="px-3 py-1 bg-blue-500 text-white text-sm rounded hover:bg-blue-600"
                                    onClick={handleSaveFile}
                                >
                                    저장하기
                                </button>
                                <button
                                    className="px-3 py-1 text-gray-400 text-sm hover:text-gray-600"
                                    onClick={() => setReceivedFile(null)}
                                >
                                    닫기
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* 숨김 파일 입력 (단일 파일) */}
            <input
                type="file"
                ref={fileInputRef}
                className="hidden"
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
            {selectedFile && selectedUser && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-30">
                    <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
                        <h3 className="text-lg font-semibold mb-4">
                            {selectedUser.nickname}에게 전송
                        </h3>
                        <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 mb-4 text-center">
                            <p className="text-sm text-gray-700">{selectedFile.name}</p>
                            <p className="text-xs text-gray-400 mt-1">
                                {(selectedFile.size / 1024).toFixed(1)} KB
                            </p>
                        </div>
                        {isSending && (
                            <p className="text-sm text-blue-500 mb-3 text-center">전송 중...</p>
                        )}
                        <div className="flex justify-end gap-3">
                            <button
                                onClick={() => {
                                    setSelectedFile(null);
                                    setSelectedUser(null);
                                }}
                                disabled={isSending}
                                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                            >
                                취소
                            </button>
                            <button
                                onClick={handleSendFile}
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
        </div>
    );
};

export default App;
