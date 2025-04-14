import React, { useState, useEffect, useRef } from "react";
import netdropsLogo from "./Netdrops.jpg";

// 최대 동시 파일 전송 개수
const MAX_CONCURRENT_FILES = 30;

interface User {
  id: string;
  nickname: string;
  sessionId?: string; // 서버에서 init 메시지로 할당됨
  isOnline?: boolean;
}

interface SystemMessage {
  id: number;
  message: string;
  timestamp: string;
}

// UUID 생성 함수 (RFC4122 v4)
const generateUUID = (): string => {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
};

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [showWifiAlert, setShowWifiAlert] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [showContextMenu, setShowContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [modal, setModal] = useState({ visible: false, message: "" });
  const [showFileSelectModal, setShowFileSelectModal] = useState(false);

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

  // 송신자가 사용자를 클릭하면 파일 전송 요청
  const handleUserClick = (user: User) => {
    setSelectedUser(user);
    if (ws.current && currentUser) {
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
    ws.current = new WebSocket("ws://localhost:8080/ws");

    ws.current.onopen = () => {
      addSystemMessage("서버에 연결되었습니다.");
      setModal({ visible: false, message: "" });
    };

    ws.current.onmessage = (event) => {
      if (typeof event.data === "string") {
        console.log("서버로부터 문자열 메시지:", event.data);
        if (event.data.indexOf("상대방과 같은 서브넷에 있지 않아 전송할 수 없습니다") !== -1) {
          setModal({
            visible: true,
            message: "같은 wifi에 연결되어 있지 않아요. 같은 wifi에 접속해주세요.",
          });
          return;
        }
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
                addSystemMessage("상대방이 전송 요청을 수락하였습니다. 파일을 전송해주세요.");
                setShowFileSelectModal(true);
              } else {
                addSystemMessage("상대방이 전송 요청을 거절하였습니다.");
              }
              break;
            default:
              addSystemMessage("서버 메시지: " + event.data);
          }
        } catch (error) {
          addSystemMessage("서버: " + event.data);
        }
      } else {
        console.log("서버로부터 바이너리 메시지 수신");
        const blob = event.data instanceof Blob ? event.data : new Blob([event.data]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.style.display = "none";
        a.href = url;
        a.download = "Netdrops_download.jpg";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    };

    ws.current.onerror = (error) => {
      addSystemMessage("WebSocket 에러 발생");
    };

    ws.current.onclose = () => {
      addSystemMessage("연결이 종료되었습니다.");
    };

    return () => {
      ws.current?.close();
    };
  }, []);

  const handleSendFiles = () => {
    if (selectedFiles.length > 0 && selectedUser) {
      addSystemMessage(`Sending ${selectedFiles.length} files to ${selectedUser.nickname}...`);
      const isInSameSubnet = Math.random() >= 0.25;
      if (!isInSameSubnet) {
        addSystemMessage("상대방과 같은 서브넷에 있지 않아 전송할 수 없습니다.");
        setShowWifiAlert(true);
        setModal({
          visible: true,
          message: "같은 wifi에 연결되어 있지 않아요. 같은 wifi에 접속해주세요.",
        });
        return;
      }
      selectedFiles.forEach((file) => {
        const fileId = generateUUID();
        ws.current?.send(JSON.stringify({ type: "meta", fileId, target: selectedUser.sessionId }));
        const reader = new FileReader();
        reader.onload = (ev) => {
          const arrayBuffer = ev.target?.result;
          if (arrayBuffer instanceof ArrayBuffer) {
            const encoder = new TextEncoder();
            const header = encoder.encode(fileId);
            const combined = new Uint8Array(header.length + arrayBuffer.byteLength);
            combined.set(header, 0);
            combined.set(new Uint8Array(arrayBuffer), header.length);
            ws.current?.send(combined.buffer);
          }
        };
        reader.readAsArrayBuffer(file);
      });
      setSelectedFiles([]);
      setSelectedUser(null);
      setShowTransferModal(false);
      setShowFileSelectModal(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const filesArray = Array.from(e.target.files);
      if (filesArray.length > MAX_CONCURRENT_FILES) {
        alert("You can only select up to 30 files at once.");
        return;
      }
      setSelectedFiles(filesArray);
      setShowFileSelectModal(false);
    }
  };

  const handleTransferResponse = (accepted: boolean) => {
    if (ws.current && selectedUser) {
      ws.current.send(
        JSON.stringify({
          type: "response",
          data: { accepted },
          target: selectedUser.sessionId,
        })
      );
    }
    setShowTransferModal(false);
    setSelectedUser(null);
  };

  const clearSearch = () => {
    setSearchTerm("");
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

      {/* 상단 헤더는 왼쪽 상단 고정 */}
      <div className="fixed top-0 left-0 z-40 flex items-center m-4">
        <img src={netdropsLogo} alt="Netdrops Logo" className="w-10 h-10 mr-2" />
        <h1 className="text-2xl font-bold text-primary">Netdrops</h1>
      </div>

      {/* 메인 콘텐츠 영역 */}
      <div className="flex flex-col items-center justify-center min-h-screen pt-20">
        {/* 내 정보 (ID와 접속 상태) - 검색 영역 위에 표시 */}
        {currentUser && (
          <div className="max-w-md w-full px-4 mb-4 text-center text-sm text-gray-500">
            내 ID: {currentUser.id} | {currentUser.isOnline ? "접속중" : "오프라인"}
          </div>
        )}

        {/* 서비스 소개 섹션 (Hero) */}
        <section className="bg-white rounded-xl p-8 shadow-subtle text-center mb-8 max-w-xl">
          <p className="text-gray-600 text-lg">
            Netdrops는 쉽고 빠르게 사진을 전송할 수 있는 서비스입니다.
            <br />
            간편한 인터페이스와 안정적인 연결로, 같은 네트워크에 있는 사용자와 소중한 사진을 손쉽게 공유하세요.
          </p>
        </section>

        {/* 검색 영역 */}
        <div className="max-w-md w-full mb-6">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <i className="fas fa-search text-gray-400"></i>
            </div>
            <input
              type="text"
              className="block w-full pl-10 pr-10 py-2 border border-gray-300 rounded-full focus:ring-primary focus:border-primary text-sm"
              placeholder="전송하고자 하는 디바이스의 닉네임을 검색해주세요"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button
                className="absolute inset-y-0 right-0 pr-3 flex items-center cursor-pointer rounded"
                onClick={clearSearch}
              >
                <i className="fas fa-times text-gray-400"></i>
              </button>
            )}
          </div>
        </div>

        {/* 사용자 목록 Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-8">
          {filteredUsers.length === 0
            ? "No users connected."
            : filteredUsers
                .filter(user => user.sessionId !== currentUser?.sessionId)
                .map(user => (
                  <div
                    key={user.id}
                    className="bg-white rounded-xl p-4 shadow-subtle hover:shadow-md transition duration-200 text-center cursor-pointer transform hover:-translate-y-1"
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
        onChange={handleFileSelect}
        accept="image/*"
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
              <h3 className="text-lg font-semibold">File Transfer Request</h3>
              <p className="text-gray-600 mt-1">
                {selectedUser.nickname} wants to share files with you
              </p>
            </div>
            <div className="flex justify-center gap-3 mt-6">
              <button
                onClick={() => handleTransferResponse(false)}
                className="px-5 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              >
                Decline
              </button>
              <button
                onClick={() => handleTransferResponse(true)}
                className="px-5 py-2 bg-primary text-white rounded-md hover:bg-blue-600"
              >
                Accept
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
