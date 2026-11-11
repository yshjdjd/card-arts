import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

const bootstrap=async()=>{
 if(location.hash.startsWith('#desktop-session=')){
   const token=location.hash.slice('#desktop-session='.length);
   history.replaceState(null,'',location.pathname+location.search+'#/');
   const response=await fetch('/api/v1/local/session',{method:'POST',headers:{Authorization:'Bearer '+token}});
   if(!response.ok)throw new Error('本机会话认证失败，请重新从桌面启动器打开');
 }
 if (!location.hash) location.hash = '#/';
};
const start=async()=>{await bootstrap();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

};
void start().catch(e=>{document.getElementById('root')!.textContent=(e as Error).message;});
