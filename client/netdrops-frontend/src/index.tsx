import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

// "ReactDOM.render" 구문은 제거하고 createRoot 방식을 사용
const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// 성능 측정을 원하면 reportWebVitals를 사용
reportWebVitals();
