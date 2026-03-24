import React, { useState, useEffect, useRef } from "react";
import { Github, HelpCircle, FileText, Download, Users } from "lucide-react";

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

        // 모바일에서만 공유 API 사용 (데스크탑은 바로 다운로드)
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        if (isMobile && navigator.share && navigator.canShare) {
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
        <div className="min-h-screen bg-gradient-to-b from-blue-50 via-white to-white flex flex-col">
            {/* 연결 안내 모달 */}
            {modal.visible && (
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-30">
                    <div className="bg-white rounded-2xl p-8 max-w-sm w-full mx-4 shadow-2xl text-center animate-modal">
                        <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-blue-50 flex items-center justify-center">
                            <div className="animate-spin rounded-full h-6 w-6 border-2 border-blue-200 border-t-blue-500"></div>
                        </div>
                        <p className="text-base font-semibold text-gray-800">{modal.message}</p>
                        <button
                            className="mt-6 px-6 py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-blue-600 transition"
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
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
                    <div className="bg-white rounded-2xl p-8 max-w-sm w-full mx-4 shadow-2xl animate-modal">
                        <h2 className="text-lg font-bold mb-3 text-gray-900">Netdrops 소개</h2>
                        <p className="text-gray-600 text-sm leading-relaxed mb-6">
                            Netdrops는 디바이스 제약 없이 빠르고 간편하게
                            파일을 공유할 수 있는 WebSocket 기반 파일 전송 서비스입니다.
                        </p>
                        <button
                            onClick={() => setShowInfoModal(false)}
                            className="w-full py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-blue-600 transition"
                        >
                            닫기
                        </button>
                    </div>
                </div>
            )}

            {/* 메인 콘텐츠 */}
            <div className="flex flex-col items-center justify-center min-h-screen pt-20 pb-32 px-4">
                {currentUser && currentUser.sessionId && (
                    <div className="flex items-center gap-2 mb-6 px-4 py-2 bg-white/70 backdrop-blur rounded-full shadow-sm">
                        <span className="text-sm text-gray-500">ID:</span>
                        <span className="text-sm font-semibold text-gray-800">{currentUser.nickname}</span>
                        {currentUser.isOnline ? (
                            <span className="inline-flex items-center gap-1.5 ml-1">
                                <span className="relative flex h-2.5 w-2.5">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span>
                                </span>
                                <span className="text-xs text-green-600 font-medium">접속중</span>
                            </span>
                        ) : (
                            <span className="ml-1 text-xs text-gray-400">오프라인</span>
                        )}
                    </div>
                )}

                <section className="bg-white/60 backdrop-blur rounded-2xl p-6 sm:p-8 shadow-sm text-center mb-8 max-w-lg w-full">
                    <p className="text-gray-500 text-sm sm:text-base leading-relaxed">
                        디바이스 제약 없이 쉽고 빠르게 파일을 전송할 수 있는 서비스입니다.
                        <br className="hidden sm:block" />
                        언제 어디서나 간편하게 파일을 공유하세요.
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
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 mb-8 w-full max-w-2xl">
                    {filteredUsers.filter(u => u.sessionId !== currentUser?.sessionId).length === 0
                        ? (
                            <div className="col-span-full flex flex-col items-center py-16 text-gray-300">
                                <Users className="w-16 h-16 mb-4 stroke-1" />
                                <p className="text-sm font-medium text-gray-400">접속 중인 사용자가 없습니다</p>
                                <p className="text-xs text-gray-300 mt-1">같은 네트워크에서 접속해보세요</p>
                            </div>
                        )
                        : filteredUsers
                            .filter((u) => u.sessionId !== currentUser?.sessionId)
                            .map((user, index) => (
                                <div
                                    key={user.sessionId}
                                    className="bg-white rounded-2xl p-5 shadow-sm hover:shadow-lg transition-all duration-200 hover:-translate-y-1 text-center cursor-pointer animate-fadeIn"
                                    style={{ animationDelay: `${index * 60}ms` }}
                                    onClick={() => handleUserClick(user)}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        setSelectedUser(user);
                                        setShowContextMenu({ x: e.clientX, y: e.clientY });
                                    }}
                                >
                                    <div className="w-14 h-14 mx-auto bg-primary rounded-full flex items-center justify-center text-white text-lg font-bold mb-3">
                                        {user.nickname.charAt(0).toUpperCase()}
                                    </div>
                                    <div className="text-xs font-medium text-gray-700 truncate">{user.nickname}</div>
                                </div>
                            ))}
                </div>
            </div>

            {/* 수신된 파일 (하단 고정) */}
            {receivedFile && (
                <div className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur border-t border-gray-100 shadow-2xl p-4 z-20 animate-slideUp">
                    <div className="max-w-lg mx-auto flex items-center gap-3">
                        <div className="flex-shrink-0 w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
                            <FileText className="w-5 h-5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">{receivedFile.name}</p>
                            <p className="text-xs text-gray-400">{(receivedFile.blob.size / 1024).toFixed(1)} KB</p>
                        </div>
                        <div className="flex gap-2 flex-shrink-0">
                            <button
                                className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-blue-600 transition font-medium"
                                onClick={handleSaveFile}
                            >
                                <Download className="w-4 h-4" />
                                저장
                            </button>
                            <button
                                className="px-3 py-2 text-gray-400 text-sm hover:text-gray-600 transition"
                                onClick={() => setReceivedFile(null)}
                            >
                                닫기
                            </button>
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
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-30">
                    <div className="bg-white rounded-2xl p-8 max-w-sm w-full mx-4 shadow-2xl text-center animate-modal">
                        <div className="w-14 h-14 mx-auto mb-4 bg-blue-50 rounded-2xl flex items-center justify-center">
                            <FileText className="w-7 h-7 text-primary" />
                        </div>
                        <h3 className="text-lg font-bold text-gray-900 mb-2">파일 선택</h3>
                        <p className="mb-6 text-sm text-gray-400">전송할 파일을 선택해주세요.</p>
                        <button
                            className="w-full py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-blue-600 transition"
                            onClick={() => {
                                fileInputRef.current && fileInputRef.current.click();
                                setShowFileSelectModal(false);
                            }}
                        >
                            파일 선택하기
                        </button>
                        <button
                            className="mt-3 text-sm text-gray-400 hover:text-gray-600 transition"
                            onClick={() => {
                                setShowFileSelectModal(false);
                                setSelectedUser(null);
                            }}
                        >
                            취소
                        </button>
                    </div>
                </div>
            )}

            {/* 파일 전송 확인 모달 */}
            {selectedFile && selectedUser && (
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-30">
                    <div className="bg-white rounded-2xl p-8 max-w-sm w-full mx-4 shadow-2xl animate-modal">
                        <h3 className="text-lg font-bold text-gray-900 mb-5 text-center">
                            {selectedUser.nickname}에게 전송
                        </h3>
                        <div className="bg-gray-50 rounded-xl p-4 mb-5 flex items-center gap-3">
                            <div className="flex-shrink-0 w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
                                <FileText className="w-5 h-5 text-primary" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-gray-800 truncate">{selectedFile.name}</p>
                                <p className="text-xs text-gray-400 mt-0.5">
                                    {selectedFile.size < 1024 * 1024
                                        ? `${(selectedFile.size / 1024).toFixed(1)} KB`
                                        : `${(selectedFile.size / 1024 / 1024).toFixed(1)} MB`}
                                </p>
                            </div>
                        </div>
                        {isSending && (
                            <div className="flex items-center justify-center gap-2 mb-4">
                                <div className="animate-spin rounded-full h-4 w-4 border-2 border-blue-200 border-t-blue-500"></div>
                                <p className="text-sm text-blue-500">전송 중...</p>
                            </div>
                        )}
                        <div className="flex gap-3">
                            <button
                                onClick={() => {
                                    setSelectedFile(null);
                                    setSelectedUser(null);
                                }}
                                disabled={isSending}
                                className="flex-1 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition font-medium"
                            >
                                취소
                            </button>
                            <button
                                onClick={handleSendFile}
                                disabled={isSending}
                                className="flex-1 py-2.5 bg-primary text-white rounded-lg text-sm hover:bg-blue-600 disabled:opacity-50 transition font-medium"
                            >
                                전송하기
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 파일 전송 요청 모달 (수신자 측) */}
            {showTransferModal && selectedUser && (
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-30">
                    <div className="bg-white rounded-2xl p-8 max-w-sm w-full mx-4 shadow-2xl animate-modal">
                        <div className="text-center mb-6">
                            <div className="w-16 h-16 mx-auto bg-primary rounded-full flex items-center justify-center text-white text-xl font-bold mb-4">
                                {selectedUser.nickname.charAt(0).toUpperCase()}
                            </div>
                            <h3 className="text-lg font-bold text-gray-900">파일 전송 요청</h3>
                            <p className="text-sm text-gray-400 mt-1">
                                {selectedUser.nickname}님이 전송을 요청했어요.
                            </p>
                        </div>
                        <div className="flex gap-3">
                            <button
                                onClick={() => handleTransferResponse(false)}
                                className="flex-1 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition font-medium"
                            >
                                거절하기
                            </button>
                            <button
                                onClick={() => handleTransferResponse(true)}
                                className="flex-1 py-2.5 bg-primary text-white rounded-lg text-sm hover:bg-blue-600 transition font-medium"
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
                <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-30">
                    <div className="bg-white rounded-2xl p-8 max-w-sm w-full mx-4 shadow-2xl animate-modal">
                        <div className="text-center mb-6">
                            <div className="w-20 h-20 mx-auto bg-primary rounded-full flex items-center justify-center text-white text-2xl font-bold mb-4">
                                {selectedUser.nickname.charAt(0).toUpperCase()}
                            </div>
                            <h3 className="text-lg font-bold text-gray-900">{selectedUser.nickname}</h3>
                        </div>
                        <div className="flex gap-3">
                            <button
                                onClick={() => {
                                    fileInputRef.current && fileInputRef.current.click();
                                    setShowProfileModal(false);
                                }}
                                className="flex-1 py-2.5 bg-primary text-white rounded-lg text-sm hover:bg-blue-600 transition font-medium"
                            >
                                파일 전송
                            </button>
                            <button
                                onClick={() => setShowProfileModal(false)}
                                className="flex-1 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition font-medium"
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
