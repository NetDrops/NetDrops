import React, { useState, useEffect, useRef } from "react";
import netdropsLogo from "./Netdrops.jpg";
import { Github, HelpCircle } from "lucide-react";

// 최대 동시 파일 전송 개수
const MAX_CONCURRENT_FILES = 30;

interface User {
  id: string;
  nickname: string;
  sessionId?: string; // 서버에서 init 메시지로 할당됨
  isOnline?: boolean;
}

// UUID 생성 함수 (RFC4122 v4)
const generateUUID = (): string =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [showTransferModal, setShowTransferModal] = useState<boolean>(false);
  const [showWifiAlert, setShowWifiAlert] = useState<boolean>(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [showContextMenu, setShowContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showProfileModal, setShowProfileModal] = useState<boolean>(false);
  const [modal, setModal] = useState<{ visible: boolean; message: string }>({ visible: false, message: "" });
  const [showFileSelectModal, setShowFileSelectModal] = useState<boolean>(false);
  const [showInfoModal, setShowInfoModal] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const ws = useRef<WebSocket | null>(null);

  const filteredUsers = users.filter((user) =>
    user.nickname.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const addSystemMessage = (message: string) => {
    console.log("[System Message]:", message);
  };

  const closeWifiAlert = () => {
    setShowWifiAlert(false);
    setSelectedFiles([]);
    setSelectedUser(null);
  };

  // 사용자 클릭 시 전송 요청
  const handleUserClick = (user: User) => {
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
      addSystemMessage("파일 전송 요청을 보냈습니다.");
    }
  };

  useEffect(() => {
    ws.current = new WebSocket("wss://netdrops.site/ws");
    // ws.current = new WebSocket("ws://localhost:8080/ws");
    ws.current.binaryType = "arraybuffer";

    ws.current.onopen = () => {
      addSystemMessage("서버에 연결되었습니다.");
      setModal({ visible: false, message: "" });
    };

    ws.current.onmessage = (event) => {
      if (typeof event.data === "string") {
        const txt = event.data;
        if (txt === "현재 연결중입니다. 잠시만 기다려주세요.") {
          setModal({ visible: true, message: txt });
          return;
        }
        try {
          const data = JSON.parse(txt);
          switch (data.type) {
            case "init":
              setCurrentUser({
                id: data.sessionId,
                nickname: data.nickname,
                sessionId: data.sessionId,
                isOnline: true,
              });
              addSystemMessage(`내 정보: ${data.nickname} (${data.sessionId})`);
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
              addSystemMessage(`${data.senderNickname}님이 파일 전송을 요청했습니다.`);
              break;
            case "response":
              if (data.data.accepted) {
                addSystemMessage("전송 요청이 수락되었습니다. 파일을 선택해주세요.");
                setShowFileSelectModal(true);
              } else {
                addSystemMessage("전송 요청이 거절되었습니다.");
              }
              break;
            default:
              addSystemMessage("서버 메시지: " + txt);
          }
        } catch (err) {
          addSystemMessage("파싱 오류: " + txt);
        }
      } else {
        // 바이너리 메시지 수신 → 다운로드
        const buffer = event.data as ArrayBuffer;
        const blob = new Blob([buffer], { type: "image/jpeg" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "Netdrops_download.jpg";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    };

    ws.current.onerror = () => {
      addSystemMessage("WebSocket 에러 발생");
    };

    ws.current.onclose = () => {
      addSystemMessage("연결이 종료되었습니다.");
    };

    return () => {
      ws.current?.close();
    };
  }, []);

  // 파일 전송 (한 번에 전송하도록 수정)
  const handleSendFiles = () => {
    if (!selectedFiles.length || !selectedUser) return;
    addSystemMessage(`Sending ${selectedFiles.length} files to ${selectedUser.nickname}...`);

    selectedFiles.forEach((file) => {
      const fileId = generateUUID();
      if (!ws.current) return;
      // 메타 정보 전송
      ws.current.send(
        JSON.stringify({ type: "meta", fileId, target: selectedUser.sessionId })
      );

      const reader = new FileReader();
      reader.onload = (ev) => {
        const arrayBuffer = ev.target?.result;
        if (!(arrayBuffer instanceof ArrayBuffer)) return;

        const encoder = new TextEncoder();
        const header = encoder.encode(fileId);
        const payload = new Uint8Array(header.length + arrayBuffer.byteLength);
        payload.set(header, 0);
        payload.set(new Uint8Array(arrayBuffer), header.length);

        ws.current?.send(payload.buffer);
      };
      reader.readAsArrayBuffer(file);
    });

    setSelectedFiles([]);
    setSelectedUser(null);
    setShowTransferModal(false);
    setShowFileSelectModal(false);
  };

  // 파일 선택
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
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

  // 전송 요청 응답
  const handleTransferResponse = (accepted: boolean) => {
    if (ws.current && selectedUser) {
      ws.current.send(
        JSON.stringify({ type: "response", data: { accepted }, target: selectedUser.sessionId })
      );
    }
    setShowTransferModal(false);
    setSelectedUser(null);
  };

  const clearSearch = () => setSearchTerm("");

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

  {/* GitHub 링크 (새 탭) */}
  <a
    href="https://github.com/NetDrops/NetDrops"
    target="_blank"
    rel="noopener noreferrer"
    className="hover:opacity-80"
  >
   <Github className="w-6 h-6 relative top-1 text-gray-700" />
  </a>

  {/* ? 버튼 → 모달 열기 */}
  <button
    onClick={() => setShowInfoModal(true)}
    className="hover:opacity-80"
  >
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
        사진을 공유할 수 있는 WebSocket 기반 P2P 파일 전송 서비스입니다.
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
      <div className="flex flex-col items-center justify-center min-h-screen pt-20">
      {currentUser && currentUser.sessionId && (
  <div className="max-w-md w-full px-4 mb-4 text-center text-lg font-semibold text-gray-700">
    ID: {currentUser.nickname}
    {currentUser.isOnline ? (
      <span className="inline-flex items-center ml-2">
        {/* 바깥 테두리는 회색, 위쪽 테두리만 파란색으로 */}
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
            Netdrops는 쉽고 빠르게 사진을 전송할 수 있는 서비스입니다.
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
                    key={user.id}
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

      {/* 숨김 파일 입력 */}
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        multiple
        accept="image/*"
        onChange={handleFileSelect}
      />

      {/* 파일 선택 모달 */}
      {showFileSelectModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-30">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 shadow-xl text-center">
            <h3 className="text-lg font-semibold mb-4">파일 선택</h3>
            <p className="mb-4 text-sm">파일을 선택하거나 드래그 앤 드롭으로 추가하세요.</p>
            <button
              className="px-4 py-2 bg-blue-500 text-white rounded"
              onClick={() => {
                fileInputRef.current?.click();
                setShowFileSelectModal(false);
              }}
            >
              파일 선택하기
            </button>
            <div className="mt-4">
              <button
                className="text-sm text-blue-500 underline"
                onClick={() => setShowFileSelectModal(false)}
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 파일 전송 UI */}
      {selectedFiles.length > 0 && selectedUser && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-30">
          <div className="bg-white rounded-lg p-6 max-w-xl w-full mx-4">
            <h3 className="text-lg font-semibold mb-4">Send files to {selectedUser.nickname}</h3>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 mb-4">
              <div className="text-sm mb-2">
                Selected {selectedFiles.length} {selectedFiles.length === 1 ? "file" : "files"} (max 30)
              </div>
              <div className="flex overflow-x-auto pb-2 gap-2">
                {selectedFiles.map((file, index) => (
                  <div key={index} className="flex-shrink-0 w-16 h-16 bg-gray-100 rounded overflow-hidden">
                    <img
                      src={URL.createObjectURL(file)}
                      alt={`Preview ${index}`}
                      className="w-full h-full object-cover"
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setSelectedFiles([]);
                  setSelectedUser(null);
                  setShowFileSelectModal(false);
                }}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSendFiles}
                className="px-4 py-2 bg-primary text-white rounded-md hover:bg-blue-600"
              >
                Send Photos
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
                거절하기
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
              fileInputRef.current?.click();
              setShowContextMenu(null);
            }}
          >
            <i className="fas fa-file-upload mr-2"></i>Send Files
          </button>
          <button
            className="w-full px-4 py-2 text-left hover:bg-gray-100 text-sm rounded"
            onClick={() => {
              setShowProfileModal(true);
              setShowContextMenu(null);
            }}
          >
            <i className="fas fa-user mr-2"></i>View Profile
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
              <p className="text-gray-600 mt-2">User ID: {selectedUser.id}</p>
            </div>
            <div className="flex justify-center gap-3">
              <button
                onClick={() => {
                  fileInputRef.current?.click();
                  setShowProfileModal(false);
                }}
                className="px-4 py-2 bg-primary text-white rounded-md hover:bg-blue-600"
              >
                Send Files
              </button>
              <button
                onClick={() => setShowProfileModal(false)}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              >
                Close
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
