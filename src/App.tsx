import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Upload, Download, Settings2, Image as ImageIcon, Activity, Box, Zap, Loader2, ArrowUp, ArrowDown, CheckSquare, Square, ZoomIn, ZoomOut, Maximize } from 'lucide-react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { ToolpathPreview } from './components/ToolpathPreview';
import { processImage } from './utils/imageProcessing';
import { generateSVG, generateDXF, generateGCode, Point, CNCParams, LayerGroup, categorizePaths } from './utils/exporters';

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

type Tab = 'original' | 'binary' | 'vector';

export default function App() {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('vector');
  const [layers, setLayers] = useState<LayerGroup[]>([]);
  const [mmHeight, setMmHeight] = useState<number>(0);
  const [originalSvg, setOriginalSvg] = useState<string | undefined>(undefined);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isRemovingBg, setIsRemovingBg] = useState<boolean>(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const binaryCanvasRef = useRef<HTMLCanvasElement>(null);

  // CNC and Processing Parameters
  const [threshold, setThreshold] = useState<number>(128);
  const [tolerance, setTolerance] = useState<number>(0);
  const [outputWidth, setOutputWidth] = useState<number>(100); // 100mm default
  const [colorCount, setColorCount] = useState<number>(64);
  const [pathOmit, setPathOmit] = useState<number>(0);
  const [curveTolerance, setCurveTolerance] = useState<number>(0.01);
  const [maxRes, setMaxRes] = useState<number>(1600);
  const [vectorMode, setVectorMode] = useState<'color' | 'bw'>('color'); // Users usually want color vector accurately by default
  const [cncParams, setCncParams] = useState<CNCParams>({
    toolDiameter: 3.175, // 1/8 inch
    feedRate: 1000,
    plungeRate: 300,
    safeZ: 5.0,
    cutDepth: 2.0,
    spindleSpeed: 12000,
  });

  const debouncedThreshold = useDebounce(threshold, 300);
  const debouncedTolerance = useDebounce(tolerance, 300);
  const debouncedOutputWidth = useDebounce(outputWidth, 300);
  const debouncedColorCount = useDebounce(colorCount, 300);
  const debouncedPathOmit = useDebounce(pathOmit, 300);
  const debouncedCurveTolerance = useDebounce(curveTolerance, 300);
  const debouncedMaxRes = useDebounce(maxRes, 300);

  // Load image and redraw when file changes
  useEffect(() => {
    if (imageFile) {
      let isSubscribed = true;
      setIsRemovingBg(true);

      const processBg = async () => {
        const originalUrl = URL.createObjectURL(imageFile);
        try {
          // Dynamically import removeBackground to not block initial render / avoid SSR issues
          const imgly = await import('@imgly/background-removal');
          const removeBackground = imgly.removeBackground;
          
          const blob = await removeBackground(originalUrl);
          if (isSubscribed) {
            const newUrl = URL.createObjectURL(blob);
            setImageSrc(newUrl);
            URL.revokeObjectURL(originalUrl); // cleanup original
          }
        } catch (e) {
          console.error("Failed to remove background:", e);
          if (isSubscribed) {
            setImageSrc(originalUrl); // fallback to original
          }
        } finally {
          if (isSubscribed) {
            setIsRemovingBg(false);
          }
        }
      };
      
      processBg();

      return () => {
        isSubscribed = false;
      };
    }
  }, [imageFile]);

  // Main processing pipeline
  useEffect(() => {
    if (!imageSrc) return;

    setIsProcessing(true);
    
    // We use a timeout to let the UI update its "isProcessing" state and render the spinner
    const timer = setTimeout(() => {
      const img = new Image();
      img.src = imageSrc;
      img.onerror = () => {
        console.error("Failed to load image from URL");
        setIsProcessing(false);
      };
      img.onload = () => {
        const cvs = canvasRef.current;
        const bCvs = binaryCanvasRef.current;
        if (!cvs || !bCvs) {
          setIsProcessing(false);
          return;
        }

        const ctx = cvs.getContext('2d', { willReadFrequently: true });
        const bCtx = bCvs.getContext('2d');
        if (!ctx || !bCtx) {
          setIsProcessing(false);
          return;
        }

        // Calculate target dimensions handling max limit
        let targetWidth = img.width;
        let targetHeight = img.height;
        const limit = debouncedMaxRes;
        
        // Only scale down if limit is less than 4000 (which we'll use as "Original" setting)
        if (limit < 4000) {
          if (targetWidth > limit || targetHeight > limit) {
             const ratio = Math.min(limit / targetWidth, limit / targetHeight);
             targetWidth = Math.floor(targetWidth * ratio);
             targetHeight = Math.floor(targetHeight * ratio);
          }
        }
        
        cvs.width = targetWidth;
        cvs.height = targetHeight;
        bCvs.width = cvs.width;
        bCvs.height = cvs.height;

        // Draw original scaled image
        ctx.clearRect(0, 0, cvs.width, cvs.height);
        ctx.drawImage(img, 0, 0, cvs.width, cvs.height);

        // Extract image data
        const imageData = ctx.getImageData(0, 0, cvs.width, cvs.height);

        try {
          const result = processImage(
            imageData,
            debouncedThreshold,
            debouncedTolerance,
            debouncedOutputWidth,
            vectorMode,
            debouncedColorCount,
            debouncedPathOmit,
            debouncedCurveTolerance
          );
          
          setLayers(result.layers);
          setMmHeight(result.mmHeight);
          setOriginalSvg(result.svgString);

          // Optional: Draw binary image to binary canvas just for previewing
          const bCtxToSync = bCtx;
          if (bCtxToSync) {
            const binaryData = bCtxToSync.createImageData(cvs.width, cvs.height);
            for (let i = 0; i < imageData.data.length; i += 4) {
              const r = imageData.data[i];
              const g = imageData.data[i + 1];
              const b = imageData.data[i + 2];
              const a = imageData.data[i + 3];
              const lum = 0.299 * r + 0.587 * g + 0.114 * b;
              const isDark = lum < debouncedThreshold && a > 128;
              const val = isDark ? 0 : 255;
              binaryData.data[i] = val;
              binaryData.data[i + 1] = val;
              binaryData.data[i + 2] = val;
              binaryData.data[i + 3] = 255;
            }
            bCtxToSync.putImageData(binaryData, 0, 0);
          }
          setIsProcessing(false);
        } catch (err: any) {
          console.error("Processing failed on main thread:", err, err.stack);
          alert("Error: " + err.message);
          setIsProcessing(false);
        }
      };
    }, 50);

    return () => clearTimeout(timer);
  }, [imageSrc, debouncedThreshold, debouncedTolerance, debouncedOutputWidth, vectorMode, debouncedColorCount, debouncedPathOmit, debouncedCurveTolerance, debouncedMaxRes]);

  const handleDownload = (type: 'svg' | 'filled-svg' | 'dxf' | 'gcode') => {
    const visibleLayers = layers.filter(l => l.visible);
    if (visibleLayers.length === 0) return;
    let content = '';
    let mime = '';
    let ext = '';

    if (type === 'svg') {
      content = generateSVG(visibleLayers, outputWidth, mmHeight, 'bw'); // pure line vectors
      mime = 'image/svg+xml';
      ext = 'svg';
    } else if (type === 'filled-svg') {
      content = generateSVG(visibleLayers, outputWidth, mmHeight, 'color'); // exact filled vectors colored correctly
      mime = 'image/svg+xml';
      ext = 'filled.svg';
    } else if (type === 'dxf') {
      content = generateDXF(visibleLayers, mmHeight);
      mime = 'application/dxf';
      ext = 'dxf';
    } else if (type === 'gcode') {
      const allPaths = visibleLayers.flatMap(l => l.paths);
      content = generateGCode(allPaths, cncParams, mmHeight);
      mime = 'text/plain';
      ext = 'nc';
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `toolpath.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleParamChange = (str: string, key: keyof CNCParams) => {
    setCncParams(prev => ({ ...prev, [key]: parseFloat(str) || 0 }));
  };

  return (
    <div className="flex flex-col md:flex-row h-screen bg-[#0E0E10] text-[#E4E3E0] font-sans antialiased overflow-hidden">
      
      {/* Hidden canvases for processing */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Sidebar Configuration */}
      <aside className="w-full md:w-80 border-b md:border-b-0 md:border-r border-[#2C2C30] flex flex-col bg-[#151619] shadow-2xl z-10 overflow-y-auto">
        <div className="p-6 border-b border-[#2C2C30]">
          <h1 className="text-xl tracking-tight text-white mb-2 font-mono flex items-center gap-2">
            <Zap className="w-5 h-5 text-yellow-500" />
            Raster2CNC
          </h1>
          <p className="text-xs text-[#8E9299]">Image to vector toolpath generator.</p>
        </div>

        <div className="p-6 space-y-8 flex-1">
          {/* File Upload section */}
          <div className="space-y-3">
            <label className="text-xs font-mono uppercase tracking-widest text-[#8E9299]">Input Source</label>
            <div className="relative">
              <input
                type="file"
                accept="image/png, image/jpeg, image/jpg"
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    setImageFile(e.target.files[0]);
                  }
                }}
              />
              <div className="border border-dashed border-[#404044] rounded-lg p-6 bg-[#1A1B1E] flex flex-col items-center justify-center gap-2 transition-colors hover:border-[#8E9299]">
                <Upload className="w-6 h-6 text-[#8E9299]" />
                <span className="text-sm font-medium">Drop or click to upload</span>
                <span className="text-xs text-[#8E9299] font-mono">{imageFile ? imageFile.name : 'PNG, JPG'}</span>
              </div>
            </div>
          </div>

          <hr className="border-[#2C2C30]" />

          {/* Configuration Mode */}
          <div className="space-y-4">
            <label className="text-xs font-mono uppercase tracking-widest text-[#8E9299]">Vectorization Mode</label>
            <div className="flex bg-[#1A1B1E] rounded-md border border-[#2C2C30] p-1">
              <button
                className={`flex-1 py-1 px-2 text-xs font-medium rounded ${vectorMode === 'bw' ? 'bg-[#2C2C30] text-white shadow-sm' : 'text-[#8E9299] hover:text-white'}`}
                onClick={() => setVectorMode('bw')}
              >
                B/W CNC Path
              </button>
              <button
                className={`flex-1 py-1 px-2 text-xs font-medium rounded ${vectorMode === 'color' ? 'bg-[#2C2C30] text-white shadow-sm' : 'text-[#8E9299] hover:text-white'}`}
                onClick={() => setVectorMode('color')}
              >
                Full Color SVG
              </button>
            </div>
          </div>

          <hr className="border-[#2C2C30]" />

          {/* Image Processing Parameters */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-xs font-mono uppercase tracking-widest text-[#8E9299] flex items-center gap-2">
                <Settings2 className="w-4 h-4" /> Processing
              </label>
              <button 
                onClick={() => {
                  setMaxRes(4000);
                  setPathOmit(0);
                  setCurveTolerance(0.01);
                  setColorCount(256);
                  setTolerance(0);
                }}
                className="text-[10px] uppercase font-mono bg-cyan-900/40 text-cyan-400 hover:bg-cyan-800/60 px-2 py-0.5 rounded transition-colors"
              >
                100% Accurate (Slow)
              </button>
            </div>
            
            <div className="space-y-1">
              <div className="flex justify-between text-xs mb-1">
                <span className="text-zinc-400">Processing Resolution</span>
                <span className="font-mono text-cyan-400">{maxRes >= 4000 ? 'Original' : maxRes + 'px'}</span>
              </div>
              <input 
                type="range" min="200" max="4000" step="100" value={maxRes} 
                onChange={(e) => setMaxRes(Number(e.target.value))}
                className="w-full accent-cyan-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer" 
              />
            </div>
            
            <div className="space-y-1">
              <div className="flex justify-between text-xs mb-1">
                <span className="text-zinc-400">Speckle Reduction (Noise)</span>
                <span className="font-mono text-cyan-400">{pathOmit}</span>
              </div>
              <input 
                type="range" min="0" max="64" value={pathOmit} 
                onChange={(e) => setPathOmit(Number(e.target.value))}
                className="w-full accent-cyan-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer" 
              />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-xs mb-1">
                <span className="text-zinc-400">Curve Tolerance</span>
                <span className="font-mono text-cyan-400">{curveTolerance}</span>
              </div>
              <input 
                type="range" min="0.01" max="10" step="0.01" value={curveTolerance} 
                onChange={(e) => setCurveTolerance(Number(e.target.value))}
                className="w-full accent-cyan-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer" 
              />
            </div>

            {vectorMode === 'bw' && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-zinc-400">Black/White Threshold</span>
                  <span className="font-mono text-cyan-400">{threshold}</span>
                </div>
                <input 
                  type="range" min="0" max="255" value={threshold} 
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  className="w-full accent-cyan-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer" 
                />
              </div>
            )}

            {vectorMode === 'color' && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-zinc-400">Number of Colors</span>
                  <span className="font-mono text-cyan-400">{colorCount}</span>
                </div>
                <input 
                  type="range" min="2" max="256" value={colorCount} 
                  onChange={(e) => setColorCount(Number(e.target.value))}
                  className="w-full accent-cyan-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer" 
                />
              </div>
            )}

            <div className="space-y-1">
              <div className="flex justify-between text-xs mb-1">
                <span className="text-zinc-400">Node Reduction</span>
                <span className="font-mono text-cyan-400">{tolerance === 0 ? '0 (100% Fidelity)' : tolerance}</span>
              </div>
              <input 
                type="range" min="0" max="10.0" step="0.1" value={tolerance} 
                onChange={(e) => setTolerance(Number(e.target.value))}
                className="w-full accent-cyan-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer" 
              />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-xs mb-1">
                <span className="text-zinc-400">Target Output Width (mm)</span>
              </div>
              <input 
                type="number" value={outputWidth}
                onChange={(e) => setOutputWidth(Number(e.target.value))}
                className="w-full bg-[#0E0E10] border border-[#2C2C30] rounded p-2 text-sm font-mono focus:border-cyan-500 focus:outline-none transition-colors"
                min="1"
              />
            </div>
          </div>

          <hr className="border-[#2C2C30]" />

          {/* CNC Parameters */}
          <div className="space-y-4">
            <label className="text-xs font-mono uppercase tracking-widest text-[#8E9299] flex items-center gap-2">
              <Activity className="w-4 h-4" /> CNC Parameters
            </label>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-500 font-mono uppercase">Tool Dia (mm)</span>
                <input 
                  type="number" step="0.1" value={cncParams.toolDiameter}
                  onChange={(e) => handleParamChange(e.target.value, 'toolDiameter')}
                  className="w-full bg-[#0E0E10] border border-[#2C2C30] rounded p-1.5 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-500 font-mono uppercase">Safe Z (mm)</span>
                <input 
                  type="number" step="0.1" value={cncParams.safeZ}
                  onChange={(e) => handleParamChange(e.target.value, 'safeZ')}
                  className="w-full bg-[#0E0E10] border border-[#2C2C30] rounded p-1.5 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-500 font-mono uppercase">Cut Depth (mm)</span>
                <input 
                  type="number" step="0.1" value={cncParams.cutDepth}
                  onChange={(e) => handleParamChange(e.target.value, 'cutDepth')}
                  className="w-full bg-[#0E0E10] border border-[#2C2C30] rounded p-1.5 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-500 font-mono uppercase">Spindle (RPM)</span>
                <input 
                  type="number" step="100" value={cncParams.spindleSpeed}
                  onChange={(e) => handleParamChange(e.target.value, 'spindleSpeed')}
                  className="w-full bg-[#0E0E10] border border-[#2C2C30] rounded p-1.5 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-500 font-mono uppercase">Feed (mm/m)</span>
                <input 
                  type="number" step="10" value={cncParams.feedRate}
                  onChange={(e) => handleParamChange(e.target.value, 'feedRate')}
                  className="w-full bg-[#0E0E10] border border-[#2C2C30] rounded p-1.5 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-zinc-500 font-mono uppercase">Plunge (mm/m)</span>
                <input 
                  type="number" step="10" value={cncParams.plungeRate}
                  onChange={(e) => handleParamChange(e.target.value, 'plungeRate')}
                  className="w-full bg-[#0E0E10] border border-[#2C2C30] rounded p-1.5 text-xs font-mono"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Download Section */}
        <div className="p-6 border-t border-[#2C2C30] bg-[#121316]">
          <div className="grid grid-cols-2 gap-2">
            <button 
              onClick={() => handleDownload('svg')}
              className="flex flex-col items-center justify-center p-3 rounded bg-[#1A1B1E] border border-[#2C2C30] hover:border-cyan-500 transition-colors group"
            >
              <Download className="w-4 h-4 mb-1 text-zinc-400 group-hover:text-cyan-400" />
              <span className="text-[10px] font-mono">Outline SVG</span>
            </button>
            <button 
              onClick={() => handleDownload('filled-svg')}
              className="flex flex-col items-center justify-center p-3 rounded bg-[#1A1B1E] border border-[#2C2C30] hover:border-cyan-500 transition-colors group"
              disabled={layers.length === 0}
            >
              <Download className="w-4 h-4 mb-1 text-zinc-400 group-hover:text-cyan-400" />
              <span className="text-[10px] font-mono text-center">Filled Vector</span>
            </button>
            <button 
              onClick={() => handleDownload('dxf')}
              className="flex flex-col items-center justify-center p-3 rounded bg-[#1A1B1E] border border-[#2C2C30] hover:border-cyan-500 transition-colors group"
            >
              <Download className="w-4 h-4 mb-1 text-zinc-400 group-hover:text-cyan-400" />
              <span className="text-[10px] font-mono">DXF File</span>
            </button>
            <button 
              onClick={() => handleDownload('gcode')}
              className="flex flex-col items-center justify-center p-3 rounded bg-cyan-600 border border-cyan-500 hover:bg-cyan-500 transition-colors text-white"
            >
              <Download className="w-4 h-4 mb-1" />
              <span className="text-[10px] font-mono font-bold uppercase">CNC G-Code</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main View Area */}
      <main className="flex-1 flex flex-col relative overflow-hidden bg-[#0A0A0C]">
        
        {/* Top Navbar */}
        <header className="h-14 border-b border-[#2C2C30] flex items-center px-4 bg-[#151619] justify-between shrink-0">
          <div className="flex bg-[#0E0E10] p-1 rounded-lg border border-[#2C2C30]">
            <button
              onClick={() => setActiveTab('original')}
              className={`px-4 py-1 text-xs font-medium rounded ${activeTab === 'original' ? 'bg-[#2C2C30] text-white shadow' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              <ImageIcon className="w-3.5 h-3.5 inline mr-1.5" />
              Original
            </button>
            <button
              onClick={() => setActiveTab('binary')}
              className={`px-4 py-1 text-xs font-medium rounded ${activeTab === 'binary' ? 'bg-[#2C2C30] text-white shadow' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              <Activity className="w-3.5 h-3.5 inline mr-1.5" />
              Binary
            </button>
            <button
              onClick={() => setActiveTab('vector')}
              className={`px-4 py-1 text-xs font-medium rounded ${activeTab === 'vector' ? 'bg-[#2C2C30] text-white shadow' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              <Box className="w-3.5 h-3.5 inline mr-1.5" />
              Vector Toolpath
            </button>
          </div>

          <div className="text-xs font-mono text-zinc-500 flex items-center gap-4">
             <span>Nodes: {layers.flatMap(l => l.paths).reduce((acc, p) => acc + p.length, 0).toLocaleString()}</span>
             <span>Paths: {layers.flatMap(l => l.paths).length}</span>
             <span>Size: {outputWidth}mm x {mmHeight.toFixed(1)}mm</span>
          </div>
        </header>

        {/* Viewport content */}
        <div className="flex-1 p-6 relative overflow-hidden flex items-center justify-center">
           {!imageSrc ? (
             <div className="text-zinc-600 flex flex-col items-center">
                <Upload className="w-12 h-12 mb-4 opacity-50" />
                <p>Upload a raster image to begin vectorization.</p>
             </div>
           ) : (
             <div className="w-full h-full rounded-xl overflow-auto border border-[#2C2C30] bg-[#121316] relative">
               
               {isRemovingBg && (
                 <div className="absolute inset-0 z-50 bg-black/60 flex flex-col items-center justify-center backdrop-blur-sm">
                  <Loader2 className="w-8 h-8 text-cyan-500 animate-spin mb-4" />
                  <span className="text-sm font-mono text-cyan-400">Removing Background (AI Processing)...</span>
                 </div>
               )}
               {isProcessing && !isRemovingBg && (
                 <div className="absolute inset-0 z-50 bg-black/60 flex flex-col items-center justify-center backdrop-blur-sm">
                  <Loader2 className="w-8 h-8 text-cyan-500 animate-spin mb-4" />
                  <span className="text-sm font-mono text-cyan-400">Processing vectors locally (100% Accurate)...</span>
                </div>
              )}

               <div className={`w-full h-full flex items-center justify-center absolute inset-0 transition-opacity ${activeTab === 'original' ? 'opacity-100 z-10' : 'opacity-0 z-0'}`}>
                 <img src={imageSrc} alt="Original" className="max-w-full max-h-full object-contain p-4" />
               </div>

               <div className={`w-full h-full flex items-center justify-center absolute inset-0 transition-opacity ${activeTab === 'binary' ? 'opacity-100 z-10' : 'opacity-0 z-0'}`}>
                 <canvas ref={binaryCanvasRef} className="max-w-full max-h-full object-contain p-4" />
               </div>

                <div className={`w-full h-full absolute inset-0 transition-opacity bg-black ${activeTab === 'vector' ? 'opacity-100 z-10' : 'opacity-0 z-0 p-4'}`}>
                  {vectorMode === 'bw' ? (
                    <ToolpathPreview layers={layers.filter(l => l.visible)} widthMm={debouncedOutputWidth} heightMm={mmHeight} />
                  ) : (
                    <TransformWrapper
                      initialScale={1}
                      minScale={0.1}
                      maxScale={50}
                      centerOnInit={true}
                      wheel={{ step: 0.1 }}
                    >
                      {({ zoomIn, zoomOut, resetTransform }) => (
                        <div className="w-full h-full relative">
                          <div className="absolute top-4 right-4 z-20 flex bg-black border border-zinc-700/50 rounded-lg p-1 gap-1">
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
                               viewBox={`0 0 ${debouncedOutputWidth} ${mmHeight}`}
                               className="max-w-full max-h-full drop-shadow-2xl overflow-visible"
                               style={{ width: '100%', height: '100%' }}
                               xmlns="http://www.w3.org/2000/svg"
                            >
                               {layers.filter(l => l.visible).map((layer) => (
                                 <g key={layer.id} fill={layer.color} stroke={layer.color} strokeWidth={0.1}>
                                   {layer.paths.map((path, pathIdx) => {
                                      const d = path.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${Math.round(p.x * 1000) / 1000} ${Math.round(p.y * 1000) / 1000}`).join(' ');
                                      return <path key={pathIdx} d={`${d} Z`} strokeLinecap="round" strokeLinejoin="round" />;
                                   })}
                                 </g>
                               ))}
                            </svg>
                          </TransformComponent>
                        </div>
                      )}
                    </TransformWrapper>
                  )}
                </div>

                {/* Layer Control Overlay inside viewport */}
               {activeTab === 'vector' && layers.length > 0 && (
                 <div className="absolute bottom-4 left-4 z-20 bg-[#151619]/90 backdrop-blur border border-[#2C2C30] p-3 rounded-lg shadow-xl w-96 flex flex-col pointer-events-auto max-h-[50vh]">
                   <div className="flex items-center justify-between mb-3 shrink-0">
                     <h3 className="text-xs uppercase tracking-widest text-[#8E9299] font-mono">Layers ({layers.length})</h3>
                     <div className="flex items-center gap-2">
                       <button 
                         onClick={() => setLayers(layers.map(l => ({ ...l, visible: true })))}
                         className="text-[10px] uppercase font-mono text-[#8E9299] hover:text-white transition-colors"
                       >
                         Sel All
                       </button>
                       <button 
                         onClick={() => setLayers(layers.map(l => ({ ...l, visible: false })))}
                         className="text-[10px] uppercase font-mono text-[#8E9299] hover:text-white transition-colors"
                       >
                         None
                       </button>
                     </div>
                   </div>
                   
                   <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                     {layers.map((layer, idx) => (
                       <div key={layer.id || idx} className="flex items-center gap-2 bg-[#0E0E10]/50 p-1.5 rounded border border-transparent hover:border-[#2C2C30] transition-colors">
                         <div className="flex flex-col gap-0.5">
                           <button 
                             onClick={() => {
                               if (idx === 0) return;
                               const newLayers = [...layers];
                               [newLayers[idx - 1], newLayers[idx]] = [newLayers[idx], newLayers[idx - 1]];
                               setLayers(newLayers);
                             }}
                             disabled={idx === 0}
                             className="text-zinc-600 hover:text-zinc-300 disabled:opacity-30 disabled:hover:text-zinc-600"
                           >
                             <ArrowUp size={12} strokeWidth={3} />
                           </button>
                           <button 
                             onClick={() => {
                               if (idx === layers.length - 1) return;
                               const newLayers = [...layers];
                               [newLayers[idx], newLayers[idx + 1]] = [newLayers[idx + 1], newLayers[idx]];
                               setLayers(newLayers);
                             }}
                             disabled={idx === layers.length - 1}
                             className="text-zinc-600 hover:text-zinc-300 disabled:opacity-30 disabled:hover:text-zinc-600"
                           >
                             <ArrowDown size={12} strokeWidth={3} />
                           </button>
                         </div>

                         <input
                           type="checkbox"
                           checked={layer.visible}
                           onChange={(e) => {
                             const newLayers = [...layers];
                             newLayers[idx].visible = e.target.checked;
                             setLayers(newLayers);
                           }}
                           className="w-4 h-4 cursor-pointer accent-cyan-500"
                         />
                         <input 
                           type="color" 
                           value={layer.color}
                           onChange={(e) => {
                             const newLayers = [...layers];
                             newLayers[idx].color = e.target.value;
                             setLayers(newLayers);
                           }}
                           className="w-5 h-5 rounded cursor-pointer border border-[#2C2C30] bg-[#0E0E10]"
                         />
                         <input 
                           type="text"
                           value={layer.name}
                           onChange={(e) => {
                             const newLayers = [...layers];
                             newLayers[idx].name = e.target.value;
                             setLayers(newLayers);
                           }}
                           className="flex-1 bg-[#0E0E10] border border-[#2C2C30] rounded p-1 text-[10px] font-mono focus:border-cyan-500 focus:outline-none"
                         />
                         <span className="text-[10px] text-zinc-500 font-mono w-10 text-right">{layer.paths.length}p</span>
                       </div>
                     ))}
                   </div>
                 </div>
               )}
             </div>
           )}
        </div>
      </main>
    </div>
  );
}

