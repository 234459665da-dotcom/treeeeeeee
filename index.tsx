import React, { ErrorInfo, ReactNode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

// --- BOOT LOGGING ---
const updateLoader = (msg: string) => {
    const loaderText = document.getElementById('loader-text');
    if (loaderText) loaderText.innerText = msg;
    console.log(`[System]: ${msg}`);
};

updateLoader("STARTING ENGINE...");

// --- ERROR BOUNDARY ---
interface ErrorBoundaryProps {
  children?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = { hasError: false, error: null };
  public props: ErrorBoundaryProps;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.props = props;
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Application Crash:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      const loader = document.getElementById('static-loader');
      if (loader) loader.style.display = 'none';

      return (
        <div className="fixed inset-0 bg-black text-red-500 font-mono flex flex-col items-center justify-center p-8 text-center z-[10000]">
          <h2 className="text-xl mb-4 font-bold border-b border-red-900 pb-2">SYSTEM FAILURE</h2>
          <pre className="text-xs md:text-sm max-w-full overflow-auto whitespace-pre-wrap bg-red-950/20 p-4 rounded border border-red-900/50">
            {this.state.error?.message || "Unknown Runtime Error"}
          </pre>
          <button 
            onClick={() => window.location.reload()}
            className="mt-8 px-6 py-2 bg-red-900/30 border border-red-500 hover:bg-red-900/50 text-white rounded transition-colors"
          >
            REBOOT SYSTEM
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- MOUNT ---
const rootElement = document.getElementById('root');
if (rootElement) {
  updateLoader("MOUNTING UI...");
  try {
    const root = createRoot(rootElement);
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
            <App />
        </ErrorBoundary>
      </React.StrictMode>
    );
  } catch (e: any) {
    console.error("Root render failed:", e);
    const errorLog = document.getElementById('error-log');
    if (errorLog) errorLog.innerText = `Fatal: Root Render Failed\n${e?.message || e}`;
    updateLoader("RENDER FAILURE");
  }
} else {
    console.error("Root element not found");
    const errorLog = document.getElementById('error-log');
    if (errorLog) errorLog.innerText = "Fatal: #root element missing from index.html";
}