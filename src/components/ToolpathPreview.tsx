import { LayerGroup } from '../utils/exporters';
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { Play, Pause, RotateCcw, ZoomIn, ZoomOut, Maximize } from 'lucide-react';

interface ToolpathPreviewProps {
  layers: LayerGroup[];
  widthMm: number;
  heightMm: number;
}

interface Point {
  x: number;
  y: number;
}

interface Segment {
  type: 'G0' | 'G1';
  p1: Point;
  p2: Point;
  length: number;
  layerIdx: number;
}

export function ToolpathPreview({ layers, widthMm, heightMm }: ToolpathPreviewProps) {
  const [viewMode, setViewMode] = useState<'svg' | 'gcode'>('svg');
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0 to totalDistance
  const animationRef = useRef<number | null>(null);

  const padding = widthMm * 0.05;
  const viewBoxX = -padding;
  const viewBoxY = -padding;
  const viewBoxW = widthMm + padding * 2;
  const viewBoxH = heightMm + padding * 2;

  // Compute all linear segments for CNC simulation
  const { segments, totalDistance } = useMemo(() => {
    const segs: Segment[] = [];
    let currentPos = { x: 0, y: 0 }; // Start at origin
    let dist = 0;

    layers.forEach((layer, layerIdx) => {
      layer.paths.forEach(path => {
        if (path.length === 0) return;
        
        const start = path[0];
        const g0Len = Math.hypot(start.x - currentPos.x, start.y - currentPos.y);
        if (g0Len > 0) {
          segs.push({ type: 'G0', p1: currentPos, p2: start, length: g0Len, layerIdx });
          dist += g0Len;
        }
        currentPos = start;

        for (let i = 1; i <= path.length; i++) {
          const p2 = i === path.length ? path[0] : path[i];
          const g1Len = Math.hypot(p2.x - currentPos.x, p2.y - currentPos.y);
          if (g1Len > 0) {
            segs.push({ type: 'G1', p1: currentPos, p2, length: g1Len, layerIdx });
            dist += g1Len;
          }
          currentPos = p2;
        }
      });
    });
    return { segments: segs, totalDistance: dist };
  }, [layers]);

  useEffect(() => {
    if (isPlaying) {
      let lastTime = performance.now();
      const speed = totalDistance / 10; // 10 seconds to finish

      const loop = (time: number) => {
        const dt = (time - lastTime) / 1000;
        lastTime = time;
        
        setProgress(prev => {
          const next = prev + speed * dt;
          if (next >= totalDistance) {
            setIsPlaying(false);
            return totalDistance;
          }
          return next;
        });
        
        animationRef.current = requestAnimationFrame(loop);
      };
      
      animationRef.current = requestAnimationFrame(loop);
    }

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isPlaying, totalDistance]);

  if (layers.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-400 bg-zinc-900 rounded-lg border border-zinc-800">
        No toolpaths generated. Adjust threshold or upload an image.
      </div>
    );
  }

  // To render simulation, we find which segment we are currently in
  let currentDist = 0;
  let headPos = { x: 0, y: 0 };
  const pastSegments: Segment[] = [];
  const futureSegments: Segment[] = [];
  let currentSegment: Segment | null = null;
  let partialLength = 0;

  if (viewMode === 'gcode') {
    for (const seg of segments) {
      if (currentDist + seg.length <= progress) {
        pastSegments.push(seg);
        currentDist += seg.length;
      } else if (currentDist <= progress && progress < currentDist + seg.length) {
        currentSegment = seg;
        partialLength = progress - currentDist;
        const ratio = partialLength / seg.length;
        headPos = {
          x: seg.p1.x + (seg.p2.x - seg.p1.x) * ratio,
          y: seg.p1.y + (seg.p2.y - seg.p1.y) * ratio
        };
        currentDist += seg.length; // Ensure later ones go to future
      } else {
        futureSegments.push(seg);
      }
    }
    // If progress is at the end
    if (progress >= totalDistance && segments.length > 0) {
      headPos = segments[segments.length - 1].p2;
    }
  }

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    setProgress(Number(e.target.value));
  };

  return (
    <div className="w-full h-full bg-zinc-900 rounded-lg border border-zinc-800 flex items-center justify-center p-4 overflow-hidden relative group">
      
      {/* Top Left info */}
      <div className="absolute top-4 left-4 text-xs font-mono text-zinc-500 z-10 bg-zinc-900/80 px-2 py-1 rounded">
        Origin (0,0) is top-left
      </div>

      {/* Top Right Toggle */}
      <div className="absolute top-4 right-4 z-10 flex bg-black border border-zinc-700/50 rounded-lg p-1">
        <button
          onClick={() => setViewMode('svg')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${viewMode === 'svg' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-white'}`}
        >
          Vector
        </button>
        <button
          onClick={() => setViewMode('gcode')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${viewMode === 'gcode' ? 'bg-zinc-800 text-cyan-400 shadow-sm' : 'text-zinc-400 hover:text-white'}`}
        >
          G-Code Sim
        </button>
      </div>

      {/* Bottom scrub bar for G-Code */}
      {viewMode === 'gcode' && (
        <div className="absolute bottom-4 left-0 right-0 z-10 flex flex-col items-center px-16 pointer-events-auto opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="bg-black/90 backdrop-blur w-full max-w-2xl border border-zinc-700 p-3 rounded-xl shadow-2xl flex items-center gap-4">
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="text-white hover:text-cyan-400 transition-colors focus:outline-none"
            >
              {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6" />}
            </button>
            <button
              onClick={() => {
                setIsPlaying(false);
                setProgress(0);
              }}
              className="text-zinc-400 hover:text-white transition-colors focus:outline-none"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <input
              type="range"
              min="0"
              max={totalDistance}
              step="0.1"
              value={progress}
              onChange={handleSeek}
              onMouseDown={() => setIsPlaying(false)}
              className="flex-1 accent-cyan-500 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
            />
            <div className="text-xs font-mono text-cyan-400 w-16 text-right">
              {Math.round((progress / totalDistance) * 100)}%
            </div>
          </div>
        </div>
      )}

      {/* Main SVG Area */}
      <TransformWrapper
        initialScale={1}
        minScale={0.1}
        maxScale={50}
        centerOnInit={true}
        wheel={{ step: 0.1 }}
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex bg-black border border-zinc-700/50 rounded-lg p-1 gap-1">
              <button onClick={() => zoomIn()} className="p-1.5 text-zinc-400 hover:text-white rounded-md hover:bg-zinc-800 transition-colors">
                <ZoomIn className="w-4 h-4" />
              </button>
              <button onClick={() => zoomOut()} className="p-1.5 text-zinc-400 hover:text-white rounded-md hover:bg-zinc-800 transition-colors">
                <ZoomOut className="w-4 h-4" />
              </button>
              <button onClick={() => resetTransform()} className="p-1.5 text-zinc-400 hover:text-white rounded-md hover:bg-zinc-800 transition-colors">
                <Maximize className="w-4 h-4" />
              </button>
            </div>
            <TransformComponent wrapperClass="!w-full !h-full" contentClass="!w-full !h-full flex items-center justify-center pointer-events-auto">
              <svg
                viewBox={`${viewBoxX} ${viewBoxY} ${viewBoxW} ${viewBoxH}`}
                className="max-w-full max-h-full drop-shadow-2xl"
                style={{ width: '100%', height: '100%' }}
              >
                <rect x="0" y="0" width={widthMm} height={heightMm} fill="transparent" stroke="#3f3f46" strokeWidth={widthMm * 0.002} strokeDasharray={`${widthMm * 0.02} ${widthMm * 0.02}`} />
                
                {viewMode === 'svg' ? (
                  /* STD Vector Layer Render */
                  layers.map((layer, layerIdx) => (
                    <g key={layerIdx} stroke={layer.color} fill="none" strokeWidth={widthMm * 0.0015}>
                      {layer.paths.map((path, pathIdx) => {
                        const d = path.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
                        return <path key={pathIdx} d={`${d} Z`} className="vector-path" strokeLinecap="round" strokeLinejoin="round" />;
                      })}
                    </g>
                  ))
                ) : (
                  /* GCode Simulation Render */
                  <g fill="none">
                    {/* Future segments shown faintly */}
                    <g opacity="0.15">
                      {futureSegments.map((seg, i) => (
                        <line 
                          key={`future-${i}`}
                          x1={seg.p1.x} y1={seg.p1.y} 
                          x2={seg.p2.x} y2={seg.p2.y} 
                          stroke={seg.type === 'G0' ? '#ef4444' : layers[seg.layerIdx].color} 
                          strokeWidth={widthMm * 0.0015} 
                          strokeDasharray={seg.type === 'G0' ? `${widthMm * 0.01} ${widthMm * 0.01}` : 'none'}
                        />
                      ))}
                    </g>
                    
                    {/* Past segments shown bright */}
                    {pastSegments.map((seg, i) => (
                      <line 
                        key={`past-${i}`}
                        x1={seg.p1.x} y1={seg.p1.y} 
                        x2={seg.p2.x} y2={seg.p2.y} 
                        stroke={seg.type === 'G0' ? '#ef4444' : layers[seg.layerIdx].color} 
                        strokeWidth={widthMm * 0.002} 
                        strokeDasharray={seg.type === 'G0' ? `${widthMm * 0.01} ${widthMm * 0.01}` : 'none'}
                      />
                    ))}

                    {/* Current partial segment */}
                    {currentSegment && (
                      <line 
                        x1={currentSegment.p1.x} y1={currentSegment.p1.y} 
                        x2={headPos.x} y2={headPos.y} 
                        stroke={currentSegment.type === 'G0' ? '#ef4444' : layers[currentSegment.layerIdx].color} 
                        strokeWidth={widthMm * 0.002} 
                        strokeDasharray={currentSegment.type === 'G0' ? `${widthMm * 0.01} ${widthMm * 0.01}` : 'none'}
                      />
                    )}

                    {/* CNC Tool Head */}
                    <circle cx={headPos.x} cy={headPos.y} r={widthMm * 0.015} fill="#06b6d4" />
                    <circle cx={headPos.x} cy={headPos.y} r={widthMm * 0.005} fill="#ffffff" />
                  </g>
                )}
              </svg>
            </TransformComponent>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}
