import React, { useState } from 'react';
import ObsidianGraph from './components/ObsidianGraph';

export const App: React.FC = () => {
  const [currentRoute, setCurrentRoute] = useState<string | null>(null);

  const handleNavigate = (routePath: string, nodeId: string) => {
    setCurrentRoute(`${routePath} (${nodeId})`);
    if (typeof window !== 'undefined') {
      window.history.pushState({ nodeId }, '', routePath);
    }
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#1e1e1e]">
      {currentRoute && (
        <div className="absolute top-3 right-3 z-20 flex items-center gap-2 px-3 py-1.5 rounded bg-[#252526]/90 border border-[#333333] text-xs text-[#a882ff] backdrop-blur-sm shadow-lg">
          <span className="w-2 h-2 rounded-full bg-[#a882ff] animate-pulse" />
          <span className="font-mono">{currentRoute}</span>
          <button
            onClick={() => setCurrentRoute(null)}
            className="ml-2 text-[#8b949e] hover:text-white"
          >
            ×
          </button>
        </div>
      )}
      <ObsidianGraph onNavigate={handleNavigate} />
    </div>
  );
};

export default App;
