import React, { useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass';
import { FilesetResolver, HandLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { AppMode, Particle, GestureType } from './types';

// --- Constants ---
const PARTICLE_COUNT = 600; 
const DUST_COUNT = 3500;    
const LIGHT_PARTICLE_COUNT = 600; 
const SMALL_STAR_COUNT = 150;     
const TREE_HEIGHT = 55;
const TREE_BASE_RADIUS = 22;
const SCATTER_RADIUS = 75;
const LERP_SPEED = 0.035; 
const ZOOM_POS = new THREE.Vector3(0, 5, 55); 
// PREVIEW POS: The 3D location where the photo spawns. 
const PREVIEW_WORLD_POS = new THREE.Vector3(0, 3, 72); 

// --- PALETTE ---
const COLOR_MATTE_GREEN = 0x1a4a2a;    
const COLOR_RICH_GOLD = 0xffbf00;      
const COLOR_DEEP_RED = 0xc2002b;       
const COLOR_BG = 0x010201;             
const COLOR_BEAR = 0x7a4a1b;
const FAIRY_LIGHT_COLORS = [0xffd700, 0xffaa00, 0xfff0b3, 0xffcc00];

// Math Cache
const _tempV1 = new THREE.Vector3();
const _tempQ1 = new THREE.Quaternion();

// --- Helpers ---
const getErrorMessage = (error: unknown): string => {
    if (!error) return "Unknown Error";
    if (error instanceof Error) return error.message;
    return String(error);
};

const downloadWithProgress = async (url: string, onProgress: (p: number) => void): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const total = parseInt(response.headers.get('content-length') || '0', 10);
  if (!total) {
      const blob = await response.blob();
      onProgress(100);
      return URL.createObjectURL(blob);
  }
  const reader = response.body?.getReader();
  if (!reader) {
       const blob = await response.blob();
       onProgress(100);
       return URL.createObjectURL(blob);
  }
  let loaded = 0;
  const chunks = [];
  while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) { chunks.push(value); loaded += value.length; onProgress((loaded / total) * 100); }
  }
  return URL.createObjectURL(new Blob(chunks));
};

// Generate points for the text "VAVE"
const getVavePoints = (count: number): THREE.Vector3[] => {
    const cvs = document.createElement('canvas');
    cvs.width = 300; cvs.height = 120;
    const ctx = cvs.getContext('2d');
    if(!ctx) return Array(count).fill(new THREE.Vector3());
    
    // Bold, Heavy font for better readability
    ctx.font = '900 80px "Arial Black", sans-serif'; 
    ctx.fillStyle = 'white';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText("VAVE", 150, 60);
    
    const imgData = ctx.getImageData(0,0,300,120);
    const validPixels: {x:number, y:number}[] = [];
    // Scan pixel data
    for(let y=0; y<120; y+=2) {
        for(let x=0; x<300; x+=2) {
            // Check alpha channel
            if(imgData.data[(y*300+x)*4 + 3] > 128) {
                validPixels.push({x, y});
            }
        }
    }
    
    const results = [];
    if (validPixels.length === 0) return Array(count).fill(new THREE.Vector3());

    for(let i=0; i<count; i++) {
        const p = validPixels[Math.floor(Math.random() * validPixels.length)];
        // Map 2D canvas to 3D world space
        // Scale factor controls the size of the text in 3D
        const scale = 0.5;
        const vec = new THREE.Vector3(
            (p.x - 150) * scale, 
            -(p.y - 60) * scale + 5, // Lift up slightly to center vertically
            (Math.random() - 0.5) * 6 // Add depth thickness
        );
        results.push(vec);
    }
    return results;
};

let _snowflakeTexture: THREE.Texture | null = null;
const getSnowflakeTexture = () => {
  if (_snowflakeTexture) return _snowflakeTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)'); 
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 64, 64);
  }
  _snowflakeTexture = new THREE.CanvasTexture(canvas);
  return _snowflakeTexture;
};

const createStarGeometry = (radius = 1, thickness = 0.5) => {
  const innerRadius = radius * 0.45;
  const vertices = [0, 0, thickness, 0, 0, -thickness];
  const numPoints = 10; 
  for (let i = 0; i < numPoints; i++) {
    const r = i % 2 === 0 ? radius : innerRadius;
    const a = (i / numPoints) * Math.PI * 2 + Math.PI / 2;
    vertices.push(Math.cos(a) * r, Math.sin(a) * r, 0);
  }
  const indices = [];
  const ringStart = 2; 
  for (let i = 0; i < numPoints; i++) {
    const current = ringStart + i;
    const next = ringStart + ((i + 1) % numPoints);
    indices.push(0, current, next);
    indices.push(1, next, current);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
};

// Types for internal state machine
type CaptureState = 'IDLE' | 'COUNTDOWN' | 'FLASH' | 'DEVELOPING' | 'FLYING';

const App: React.FC = () => {
  const [appMode, setAppMode] = useState<AppMode>(AppMode.LOADING);
  const [loadingProgress, setLoadingProgress] = useState(0); 
  const [loadingStage, setLoadingStage] = useState<string>("SYSTEM STARTUP");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [visionStatus, setVisionStatus] = useState<string>('INIT');
  const [visionStatusText, setVisionStatusText] = useState<string>('');
  
  // Photography State
  const [captureState, setCaptureState] = useState<CaptureState>('IDLE');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const [snapshotImage, setSnapshotImage] = useState<string | null>(null); 
  
  const [camMessage, setCamMessage] = useState<string>("NOEL ELEGANCE");
  const [currentGesture, setCurrentGesture] = useState<GestureType>('NONE');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const holdBarRef = useRef<HTMLDivElement>(null);
  const rotationSpeedRef = useRef(0.002); 
  const gestureRef = useRef<GestureType>('NONE');
  const mainGroupRef = useRef<THREE.Group | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const atmosphereRef = useRef<THREE.Points | null>(null);
  const snowDataRef = useRef<{ velocities: Float32Array; sways: Float32Array }>({
    velocities: new Float32Array(DUST_COUNT), sways: new Float32Array(DUST_COUNT)
  });
  
  const zoomedPhotoRef = useRef<Particle | null>(null);
  const previewingPhotoRef = useRef<Particle | null>(null); 
  const mountRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<AppMode>(AppMode.LOADING);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const lShapeHoldTimeRef = useRef(0);
  const pinchHoldTimeRef = useRef(0);
  const isMountedRef = useRef(true);
  const frameIdRef = useRef<number>(0);
  const predictRef = useRef<number>(0);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  
  // Locks
  const captureStateRef = useRef<CaptureState>('IDLE'); 
  const lastCaptureTimeRef = useRef(0);

  // Sync state to ref for loop access
  useEffect(() => { captureStateRef.current = captureState; }, [captureState]);

  useEffect(() => {
    const staticLoader = document.getElementById('static-loader');
    if (staticLoader) {
        staticLoader.style.opacity = '0';
        setTimeout(() => staticLoader.remove(), 500);
    }
  }, []);

  // --- PHOTOGRAPHY LOGIC ---
  const triggerCountdown = () => {
    if (captureState !== 'IDLE') return;
    if (Date.now() - lastCaptureTimeRef.current < 4000) return;

    setCaptureState('COUNTDOWN');
    setCountdown(3);
    setCamMessage("SMILE!");
  };

  useEffect(() => {
    if (captureState === 'COUNTDOWN' && countdown !== null) {
      if (countdown > 0) {
        const timer = setTimeout(() => setCountdown(c => (c !== null ? c - 1 : 0)), 1000);
        return () => clearTimeout(timer);
      } else {
        takePhoto();
      }
    }
  }, [countdown, captureState]);

  const takePhoto = () => {
     if (!mainGroupRef.current || !cameraRef.current || !videoRef.current) return;
     
     // 1. Flash Phase
     setCaptureState('FLASH');
     setFlash(true);
     setCountdown(null);
     setCamMessage("");

     // 2. Capture Content
     const canvasWidth = 512;
     const canvasHeight = 632; 
     const cvs = document.createElement('canvas'); 
     cvs.width = canvasWidth; cvs.height = canvasHeight;
     const ctx = cvs.getContext('2d');
     
     if (ctx) {
        // --- DRAW POLAROID TEXTURE (Used for 3D Model) ---
        ctx.fillStyle = '#fdfbf7'; 
        ctx.fillRect(0,0, canvasWidth, canvasHeight);
        
        const vid = videoRef.current;
        if (vid && vid.readyState >= 2) {
             const minDim = Math.min(vid.videoWidth, vid.videoHeight);
             const sx = (vid.videoWidth - minDim) / 2;
             const sy = (vid.videoHeight - minDim) / 2;
             const margin = 24; 
             const imgSize = canvasWidth - (margin * 2); 

             // Store raw photo for HTML animation (Mirror)
             const photoCvs = document.createElement('canvas');
             photoCvs.width = imgSize; photoCvs.height = imgSize;
             const pCtx = photoCvs.getContext('2d');
             if (pCtx) {
                 pCtx.translate(imgSize, 0);
                 pCtx.scale(-1, 1);
                 pCtx.drawImage(vid, sx, sy, minDim, minDim, 0, 0, imgSize, imgSize);
                 setSnapshotImage(photoCvs.toDataURL('image/jpeg', 0.9));
             }

             // Draw onto Main Texture (Mirrored)
             ctx.save();
             ctx.filter = 'contrast(1.15) saturate(1.2) brightness(1.2)'; 
             const centerX = margin + imgSize/2;
             const centerY = margin + imgSize/2;
             ctx.translate(centerX, centerY);
             ctx.scale(-1, 1);
             ctx.drawImage(vid, sx, sy, minDim, minDim, -imgSize/2, -imgSize/2, imgSize, imgSize); 
             ctx.restore();
        }

        // Draw Text on Texture (Burned in for 3D model)
        ctx.font = '700 32px Cinzel'; ctx.fillStyle = '#111'; ctx.textAlign = 'center';
        ctx.fillText("VAVE", canvasWidth / 2, canvasWidth + 45);
        ctx.font = '400 18px Cinzel'; ctx.fillStyle = '#333';
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const dateStr = now.toLocaleDateString();
        ctx.fillText(`${dateStr} • ${timeStr}`, canvasWidth / 2, canvasWidth + 85);
     }

     // 3. Create 3D Object
     const tex = new THREE.CanvasTexture(cvs);
     tex.colorSpace = THREE.SRGBColorSpace; 
     const paperMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0 });
     const photoMat = new THREE.MeshStandardMaterial({ 
         color: 0xffffff, roughness: 0.5, metalness: 0.0, 
         map: tex, 
         emissive: 0x888888, emissiveMap: tex, emissiveIntensity: 0.2
     });
     const mesh = new THREE.Mesh(new THREE.BoxGeometry(6, 7.4, 0.1), [
         paperMat, paperMat, paperMat, paperMat, photoMat, photoMat
     ]);
     
     // Position at camera center
     _tempV1.copy(PREVIEW_WORLD_POS);
     mainGroupRef.current.worldToLocal(_tempV1);
     mesh.position.copy(_tempV1);
     _tempQ1.copy(mainGroupRef.current.quaternion).invert();
     mesh.quaternion.copy(_tempQ1.multiply(cameraRef.current.quaternion));
     
     // Hide initially
     mesh.visible = false; 
     mainGroupRef.current.add(mesh);

     // Tree Target
     const normalizedHeight = (Math.random() * 0.9) - 0.45; 
     const h = normalizedHeight * TREE_HEIGHT;
     const maxRadiusAtHeight = (1 - (h + TREE_HEIGHT/2)/TREE_HEIGHT) * TREE_BASE_RADIUS;
     const radius = maxRadiusAtHeight * (0.4 + Math.random() * 0.7) + 1.0; 
     const angle = Math.random() * 6.28;
     const treePos = new THREE.Vector3(Math.cos(angle)*radius, h, Math.sin(angle)*radius);

     // Assign a random text pos for new items (or center drift)
     const textPos = new THREE.Vector3((Math.random()-0.5)*40, (Math.random()-0.5)*15, 0);

     const newP: Particle = {
         mesh, type: 'PHOTO', treePos,
         scatterPos: new THREE.Vector3((Math.random()-0.5)*140, (Math.random()-0.5)*140, (Math.random()-0.5)*140),
         textPos,
         velocity: new THREE.Vector3(), rotationSpeed: new THREE.Vector3(), isPhoto: true
     };
     particlesRef.current.push(newP);
     previewingPhotoRef.current = newP; 

     // 4. Timing
     setTimeout(() => {
         setFlash(false);
         setCaptureState('DEVELOPING'); 
     }, 150);

     setTimeout(() => {
         // --- FLY SEQUENCE ---
         setCaptureState('FLYING');
         setSnapshotImage(null); 
         
         if (newP.mesh) newP.mesh.visible = true; 
         previewingPhotoRef.current = null; // Release to tree
         
         lastCaptureTimeRef.current = Date.now();
         gestureRef.current = 'NONE'; 
         setCurrentGesture('NONE');
         lShapeHoldTimeRef.current = 0;

         setTimeout(() => {
            setCaptureState('IDLE');
         }, 1000);

     }, 4500); 
  };

  // --- MAIN EFFECT (SCENE INIT) ---
  useEffect(() => {
    isMountedRef.current = true;
    if (!mountRef.current) return;
    
    // --- SCENE SETUP ---
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLOR_BG); 
    scene.fog = new THREE.FogExp2(COLOR_BG, 0.007); 

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 3, 85);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    
    if (mountRef.current.childElementCount > 0) mountRef.current.innerHTML = '';
    mountRef.current.appendChild(renderer.domElement);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.5, 0.5, 0.85));

    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const p1 = new THREE.PointLight(0xffd700, 1000, 500); p1.position.set(60, 80, 60); scene.add(p1);
    const p2 = new THREE.PointLight(0xffaa00, 500, 400); p2.position.set(-60, -40, 50); scene.add(p2);

    // --- TEXT TARGET POINTS ---
    const totalParticles = PARTICLE_COUNT + LIGHT_PARTICLE_COUNT + SMALL_STAR_COUNT + 1;
    const vavePoints = getVavePoints(totalParticles);
    // Shuffle points for random assignment
    for (let i = vavePoints.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [vavePoints[i], vavePoints[j]] = [vavePoints[j], vavePoints[i]];
    }
    let vaveIndex = 0;

    // --- MATERIALS & GEO ---
    const goldMat = new THREE.MeshStandardMaterial({ color: COLOR_RICH_GOLD, emissive: COLOR_RICH_GOLD, emissiveIntensity: 0.3, metalness: 1.0, roughness: 0.05 });
    const redMat = new THREE.MeshPhysicalMaterial({ color: COLOR_DEEP_RED, emissive: 0x550000, emissiveIntensity: 0.2, metalness: 0.4, roughness: 0.1, clearcoat: 1.0 });
    const matteGreenMat = new THREE.MeshStandardMaterial({ color: COLOR_MATTE_GREEN, roughness: 0.8 });
    const berryMat = new THREE.MeshStandardMaterial({ color: 0xff1100, emissive: 0xff0000, emissiveIntensity: 0.8, roughness: 0.2 });
    const furMat = new THREE.MeshStandardMaterial({ color: COLOR_BEAR, roughness: 1.0 });
    const muzzleMat = new THREE.MeshStandardMaterial({ color: 0xd2b48c });
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0 });

    const wreathProto = new THREE.Group();
    wreathProto.add(new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.15, 12, 24), matteGreenMat));
    const berryGeo = new THREE.SphereGeometry(0.09, 8, 8);
    for(let i=0; i<8; i++) {
        const b = new THREE.Mesh(berryGeo, berryMat);
        const a = (i / 8) * Math.PI * 2;
        b.position.set(Math.cos(a)*0.5, Math.sin(a)*0.5, 0.1);
        wreathProto.add(b);
    }
    wreathProto.scale.setScalar(1.5);

    const bearProto = new THREE.Group();
    const bearBody = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 16), furMat); bearBody.scale.y = 1.25;
    const bearHead = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 16), furMat); bearHead.position.y = 0.6;
    const bearMuzzle = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), muzzleMat); bearMuzzle.position.set(0, 0.55, 0.28);
    const bearEarGeo = new THREE.SphereGeometry(0.09, 8, 8);
    const bearEarL = new THREE.Mesh(bearEarGeo, furMat); bearEarL.position.set(0.2, 0.85, 0.1);
    const bearEarR = new THREE.Mesh(bearEarGeo, furMat); bearEarR.position.set(-0.2, 0.85, 0.1);
    bearProto.add(bearBody, bearHead, bearMuzzle, bearEarL, bearEarR);
    bearProto.scale.setScalar(1.5);

    const hatProto = new THREE.Group();
    const hatBrim = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.12, 8, 20), whiteMat); hatBrim.rotation.x = Math.PI / 2;
    const hatBase = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 0.35, 16), redMat); hatBase.position.y = 0.18;
    const hatTop = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.6, 16), redMat); hatTop.position.set(-0.1, 0.5, 0); hatTop.rotation.z = -0.5;
    const hatPom = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 12), whiteMat); hatPom.position.set(-0.4, 0.8, 0);
    hatProto.add(hatBrim, hatBase, hatTop, hatPom);
    hatProto.scale.setScalar(1.7);

    const ballGeo = new THREE.SphereGeometry(0.75, 16, 16);
    const mainGroup = new THREE.Group(); scene.add(mainGroup); mainGroupRef.current = mainGroup;
    particlesRef.current = [];

    const getNextTextPos = () => {
        if (vaveIndex < vavePoints.length) return vavePoints[vaveIndex++];
        return new THREE.Vector3();
    }

    const topper = new THREE.Mesh(createStarGeometry(5, 1.5), new THREE.MeshStandardMaterial({
      color: 0xfff0b3, emissive: 0xffd700, emissiveIntensity: 0.4, metalness: 1.0, roughness: 0.05
    }));
    topper.position.set(0, TREE_HEIGHT/2 + 5, 0); mainGroup.add(topper);
    particlesRef.current.push({ mesh: topper, type: 'STAR_ORNAMENT', treePos: topper.position.clone(), scatterPos: new THREE.Vector3(0, 75, 0), textPos: getNextTextPos(), velocity: new THREE.Vector3(), rotationSpeed: new THREE.Vector3(0, 0.01, 0) });

    const lightGeo = new THREE.SphereGeometry(0.18, 8, 8);
    for (let i = 0; i < LIGHT_PARTICLE_COUNT; i++) {
        const c = FAIRY_LIGHT_COLORS[Math.floor(Math.random() * FAIRY_LIGHT_COLORS.length)];
        const lightMesh = new THREE.Mesh(lightGeo, new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 6.0 }));
        const hN = Math.pow(Math.random(), 0.95); const y = (hN * TREE_HEIGHT) - (TREE_HEIGHT / 2);
        const mR = TREE_BASE_RADIUS * (1.0 - (y + TREE_HEIGHT/2) / TREE_HEIGHT);
        const tP = new THREE.Vector3(Math.cos(Math.random()*6.28)*mR*(0.2+0.8*Math.sqrt(Math.random())), y, Math.sin(Math.random()*6.28)*mR*(0.2+0.8*Math.sqrt(Math.random())));
        const sP = new THREE.Vector3((Math.random()-0.5)*170, (Math.random()-0.5)*170, (Math.random()-0.5)*170);
        lightMesh.position.copy(sP); mainGroup.add(lightMesh);
        lightMesh.userData.phase = Math.random() * Math.PI * 2;
        lightMesh.userData.speed = 1.2 + Math.random() * 2.0;
        particlesRef.current.push({ mesh: lightMesh, type: 'LIGHT', treePos: tP, scatterPos: sP, textPos: getNextTextPos(), velocity: new THREE.Vector3(), rotationSpeed: new THREE.Vector3() });
    }

    const smallStarGeom = createStarGeometry(0.5, 0.2);
    const smallStarMat = new THREE.MeshStandardMaterial({ color: 0xffd700, emissive: 0xffd700, emissiveIntensity: 0.5 }); 
    for (let i = 0; i < SMALL_STAR_COUNT; i++) {
        const smStar = new THREE.Mesh(smallStarGeom, smallStarMat.clone()); 
        const hN = Math.pow(Math.random(), 0.9); const y = (hN * TREE_HEIGHT) - (TREE_HEIGHT / 2);
        const mR = TREE_BASE_RADIUS * (1.0 - (y + TREE_HEIGHT/2) / TREE_HEIGHT);
        const tP = new THREE.Vector3(Math.cos(Math.random()*6.28)*mR*(0.1+0.9*Math.sqrt(Math.random())), y, Math.sin(Math.random()*6.28)*mR*(0.1+0.9*Math.sqrt(Math.random())));
        const sP = new THREE.Vector3((Math.random()-0.5)*160, (Math.random()-0.5)*160, (Math.random()-0.5)*160);
        smStar.position.copy(sP); smStar.rotation.set(Math.random()*6.28, Math.random()*6.28, Math.random()*6.28);
        mainGroup.add(smStar);
        particlesRef.current.push({ mesh: smStar, type: 'ORNAMENT', treePos: tP, scatterPos: sP, textPos: getNextTextPos(), velocity: new THREE.Vector3(), rotationSpeed: new THREE.Vector3(Math.random()*0.02, Math.random()*0.02, Math.random()*0.02) });
    }

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      let m: THREE.Object3D; 
      let pt: Particle['type'] = 'ORNAMENT';
      const r = Math.random();
      if (r < 0.12) { m = wreathProto.clone(); }
      else if (r < 0.25) { m = hatProto.clone(); }
      else if (r < 0.35) { m = bearProto.clone(); }
      else { m = new THREE.Mesh(ballGeo, r > 0.88 ? redMat : goldMat); }
      const hN = Math.pow(Math.random(), 0.9); const y = (hN * TREE_HEIGHT) - (TREE_HEIGHT / 2);
      const mR = TREE_BASE_RADIUS * (1.0 - (y + TREE_HEIGHT/2) / TREE_HEIGHT);
      const tP = new THREE.Vector3(Math.cos(Math.random()*6.28)*mR*(0.2+0.8*Math.sqrt(Math.random())), y, Math.sin(Math.random()*6.28)*mR*(0.2+0.8*Math.sqrt(Math.random())));
      const ph=Math.acos(2*Math.random()-1), th=2*3.14*Math.random(), rS=SCATTER_RADIUS*(0.8+0.7*Math.random());
      const sP = new THREE.Vector3(rS*Math.sin(ph)*Math.cos(th), rS*Math.sin(ph)*Math.sin(th), rS*Math.cos(ph));
      m.position.copy(sP); mainGroup.add(m);
      particlesRef.current.push({ mesh: m, type: pt, treePos: tP, scatterPos: sP, textPos: getNextTextPos(), velocity: new THREE.Vector3(), rotationSpeed: new THREE.Vector3((Math.random()-0.5)*0.03, (Math.random()-0.5)*0.05, (Math.random()-0.5)*0.03) });
    }

    const snowGeo = new THREE.BufferGeometry();
    const snowPos = new Float32Array(DUST_COUNT * 3);
    const vels = new Float32Array(DUST_COUNT);
    const sws = new Float32Array(DUST_COUNT);
    for (let i = 0; i < DUST_COUNT; i++) { 
        snowPos[i*3] = (Math.random()-0.5)*250; snowPos[i*3+1] = (Math.random()-0.5)*200; snowPos[i*3+2] = (Math.random()-0.5)*250; 
        vels[i] = 0.1 + Math.random() * 0.15; sws[i] = Math.random() * 6.28;
    }
    snowDataRef.current = { velocities: vels, sways: sws };
    snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
    const snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({ 
        color: 0xffffff, size: 0.8, map: getSnowflakeTexture(), transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true 
    }));
    scene.add(snow); atmosphereRef.current = snow;

    const clock = new THREE.Clock();

    const animate = () => {
        frameIdRef.current = requestAnimationFrame(animate);
        const time = clock.getElapsedTime();
        const mode = modeRef.current;
        
        // Rotate tree unless in TEXT mode (slow down for readability)
        if (mode === AppMode.TEXT) {
             mainGroup.rotation.y += rotationSpeedRef.current * 0.1; 
             // Lerp to face front (optional, but continuous slow spin is good)
        } else {
             mainGroup.rotation.y += rotationSpeedRef.current;
        }

        particlesRef.current.forEach(p => {
            if (p.type === 'LIGHT') {
                const mat = (p.mesh as THREE.Mesh).material as THREE.MeshStandardMaterial;
                const twinkle = Math.sin(time * p.mesh.userData.speed + p.mesh.userData.phase);
                mat.emissiveIntensity = 9.0 + twinkle * 3.0; 
                const s = 1.0 + twinkle * 0.12;
                p.mesh.scale.set(s, s, s);
            }
            if (previewingPhotoRef.current === p) {
                // LOCK PHOTO TO CAMERA VIEW (Center Screen)
                if (p.mesh.visible) {
                    _tempV1.copy(PREVIEW_WORLD_POS);
                    p.mesh.parent?.worldToLocal(_tempV1);
                    p.mesh.position.copy(_tempV1);
                    _tempQ1.copy(mainGroup.quaternion).invert();
                    p.mesh.quaternion.copy(_tempQ1.multiply(camera.quaternion));
                }
                return;
            }
            if (zoomedPhotoRef.current === p) {
                const tW = ZOOM_POS;
                _tempV1.copy(tW); p.mesh.parent?.worldToLocal(_tempV1);
                p.mesh.position.lerp(_tempV1, 0.15);
                _tempQ1.copy(mainGroup.quaternion).invert();
                p.mesh.quaternion.slerp(_tempQ1.multiply(camera.quaternion), 0.15);
                const sf = 3.0; p.mesh.scale.lerp(new THREE.Vector3(sf, sf, sf), 0.12);
                return;
            }
            if (p.isPhoto) {
                p.mesh.scale.lerp(new THREE.Vector3(1, 1, 1), 0.1);
            }
            
            // TARGET SELECTION
            let target;
            if (mode === AppMode.TEXT) target = p.textPos;
            else if (mode === AppMode.TREE) target = p.treePos;
            else target = p.scatterPos;

            p.mesh.position.lerp(target, LERP_SPEED);
            p.mesh.rotation.x += p.rotationSpeed.x; p.mesh.rotation.y += p.rotationSpeed.y; p.mesh.rotation.z += p.rotationSpeed.z;
        });

        if (atmosphereRef.current) {
            const pos = atmosphereRef.current.geometry.attributes.position.array as Float32Array;
            const { velocities, sways } = snowDataRef.current;
            for (let i = 0; i < DUST_COUNT; i++) {
                pos[i*3+1] -= velocities[i]; sways[i] += 0.012; pos[i*3] += Math.sin(sways[i]) * 0.04;
                if (pos[i*3+1] < -120) pos[i*3+1] = 120;
            }
            atmosphereRef.current.geometry.attributes.position.needsUpdate = true;
        }
        composer.render();
    };
    animate();
    
    // --- PREDICTION LOOP ---
    const predictLoop = () => {
        if (!isMountedRef.current) return;
        
        const vid = videoRef.current;
        const landmarker = landmarkerRef.current;

        if (vid && vid.readyState >= 2 && landmarker) {
            if (vid.paused) vid.play().catch(e => console.warn("Auto-resume failed", e));
            try {
                if (captureStateRef.current !== 'IDLE' || Date.now() - lastCaptureTimeRef.current < 2000) {
                     predictRef.current = requestAnimationFrame(predictLoop);
                     return;
                }

                const res = landmarker.detectForVideo(vid, performance.now());
                if (res.landmarks?.[0]) {
                    const l = res.landmarks[0];
                    const wrist = l[0], tTip = l[4], iTip = l[8], mTip = l[12], rTip = l[16], pTip = l[20];
                    const tIP = l[3], tMCP = l[2];
                    
                    const isEx = (tip: NormalizedLandmark, mcpIdx: number) => {
                         const distTip = Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
                         const distMcp = Math.hypot(l[mcpIdx].x - wrist.x, l[mcpIdx].y - wrist.y);
                         return distTip > distMcp * 1.1; 
                    };

                    const iE = isEx(iTip,5), mE = isEx(mTip,9), rE = isEx(rTip,13), pE = isEx(pTip,17);
                    
                    // Stricter Thumb Extended check for Thumbs Up (1.2 instead of 1.05)
                    const tE = Math.hypot(tTip.x - wrist.x, tTip.y - wrist.y) > Math.hypot(l[3].x - wrist.x, l[3].y - wrist.y) * 1.2;
                    
                    // Index extended for L-shape?
                    const tE_Legacy = Math.hypot(tTip.x - wrist.x, tTip.y - wrist.y) > Math.hypot(l[3].x - wrist.x, l[3].y - wrist.y) * 1.05;

                    const pinchDist = Math.hypot(tTip.x-iTip.x, tTip.y-iTip.y);
                    let gest: GestureType = 'NONE';

                    // Thumbs Up Logic: Thumb Extended, Fingers Curled, Thumb Pointing Up (y check)
                    // Note: Y increases downwards. So tTip.y < tIP.y means thumb is pointing UP.
                    const thumbPointingUp = tTip.y < tIP.y && tIP.y < tMCP.y;
                    const fingersCurled = !iE && !mE && !rE && !pE;
                    
                    if (pinchDist < 0.06 && mE && rE && pE) gest = 'PINCH';
                    else if (fingersCurled && tE && thumbPointingUp) gest = 'THUMBS_UP';
                    else if (!iE && !mE && !rE && !pE) gest = 'FIST'; // Fingers curled but NOT strictly thumbs up
                    else if (iE && mE && rE && pE) gest = 'OPEN_PALM';
                    else if (tE_Legacy && iE && !pE) gest = 'L_SHAPE';
                    
                    gestureRef.current = gest;
                    setCurrentGesture(prev => prev !== gest ? gest : prev);
                    rotationSpeedRef.current = (0.5 - wrist.x) * 0.035;
                    
                    if (gest === 'OPEN_PALM') { 
                        pinchHoldTimeRef.current = 0; modeRef.current = AppMode.SCATTER; setAppMode(AppMode.SCATTER); zoomedPhotoRef.current = null; 
                    } 
                    else if (gest === 'FIST') { 
                        pinchHoldTimeRef.current = 0; modeRef.current = AppMode.TREE; setAppMode(AppMode.TREE); zoomedPhotoRef.current = null; 
                    }
                    else if (gest === 'THUMBS_UP') {
                        pinchHoldTimeRef.current = 0; modeRef.current = AppMode.TEXT; setAppMode(AppMode.TEXT); zoomedPhotoRef.current = null;
                    }
                    else if (gest === 'PINCH') {
                        if (++pinchHoldTimeRef.current > 15 && !zoomedPhotoRef.current) { 
                            const phs = particlesRef.current.filter(p => p.isPhoto);
                            if (phs.length > 0) zoomedPhotoRef.current = phs[Math.floor(Math.random()*phs.length)];
                        }
                    } 
                    else if (gest === 'L_SHAPE') {
                        pinchHoldTimeRef.current = 0;
                        setCamMessage("HOLD STEADY...");
                        if (++lShapeHoldTimeRef.current > 30) {
                            triggerCountdown();
                        }
                        if (holdBarRef.current) {
                            const pct = Math.min((lShapeHoldTimeRef.current / 30) * 100, 100);
                            holdBarRef.current.style.width = `${pct}%`;
                        }
                    } else { 
                        lShapeHoldTimeRef.current = 0; pinchHoldTimeRef.current = 0;
                        if (holdBarRef.current) holdBarRef.current.style.width = '0%';
                        setCamMessage("NOEL ELEGANCE");
                    }
                } else {
                    setCurrentGesture('NONE');
                    if (holdBarRef.current) holdBarRef.current.style.width = '0%';
                }
            } catch (err) { console.warn(err); }
        }
        predictRef.current = requestAnimationFrame(predictLoop);
    };
    predictLoop();

    const startSystem = async () => {
        if (!isMountedRef.current) return;
        setVisionStatus('INIT'); setVisionStatusText("REQUESTING CAMERA..."); setLoadingStage("ALLOW CAMERA ACCESS..."); setLoadingProgress(5);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false
            });
            if (!isMountedRef.current) { stream.getTracks().forEach(t => t.stop()); return; }
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await new Promise<void>((resolve) => {
                    if (!videoRef.current) return resolve();
                    videoRef.current.onloadedmetadata = () => { videoRef.current?.play().then(resolve).catch(resolve); };
                });
            }
            setVisionStatus('CAMERA'); setVisionStatusText("CAMERA ACTIVE"); setLoadingProgress(15);
        } catch (e: any) {
            setErrorMsg("Camera Access Denied."); setVisionStatus('ERROR'); setVisionStatusText("CAMERA BLOCKED");
            setLoadingProgress(100);
            setTimeout(() => { if (isMountedRef.current) { setAppMode(AppMode.TREE); modeRef.current = AppMode.TREE; if ((window as any).stopWatchdog) (window as any).stopWatchdog(); } }, 2000);
            return;
        }

        setVisionStatus('DOWNLOADING'); setVisionStatusText("LOADING AI BRAIN..."); setLoadingStage("DOWNLOADING AI ENGINE...");
        try {
            const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
            const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
            const vision = await FilesetResolver.forVisionTasks(WASM_URL);
            setLoadingProgress(30); setLoadingStage("DOWNLOADING MODEL (12MB)...");
            const blobUrl = await downloadWithProgress(MODEL_URL, (pct) => setLoadingProgress(30 + (pct * 0.6)));
            if (!isMountedRef.current) return;

            setLoadingStage("STARTING NEURAL NET..."); setLoadingProgress(95);
            let landmarker;
            try {
                 landmarker = await HandLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: blobUrl, delegate: "GPU" }, runningMode: "VIDEO", numHands: 1 });
            } catch(gpuError) {
                landmarker = await HandLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: blobUrl, delegate: "CPU" }, runningMode: "VIDEO", numHands: 1 });
            }
            landmarkerRef.current = landmarker;

            setLoadingProgress(100); setVisionStatus('READY'); setVisionStatusText("AI ACTIVE");
            setTimeout(() => setVisionStatusText(''), 3000);
            setTimeout(() => {
              if (isMountedRef.current) {
                setAppMode(AppMode.TREE); modeRef.current = AppMode.TREE;
                if ((window as any).stopWatchdog) (window as any).stopWatchdog();
              }
            }, 500);
        } catch (e: unknown) {
            const msg = getErrorMessage(e); setErrorMsg(`AI Error: ${msg}`); setVisionStatus('ERROR');
            setLoadingProgress(100);
            setTimeout(() => { if (isMountedRef.current) { setAppMode(AppMode.TREE); modeRef.current = AppMode.TREE; if ((window as any).stopWatchdog) (window as any).stopWatchdog(); } }, 2000);
        }
    };
    startSystem();

    const onResize = () => {
        if (!cameraRef.current) return;
        cameraRef.current.aspect = window.innerWidth / window.innerHeight; cameraRef.current.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight); composer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onResize);
    
    return () => {
        isMountedRef.current = false;
        window.removeEventListener('resize', onResize);
        cancelAnimationFrame(frameIdRef.current);
        cancelAnimationFrame(predictRef.current);
        if (videoRef.current && videoRef.current.srcObject) (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
        if (mountRef.current && renderer.domElement) mountRef.current.removeChild(renderer.domElement);
        renderer.dispose();
    };
  }, []); // Only run once on mount!

  const shouldShowCamera = appMode !== AppMode.LOADING && 
                           (captureState === 'COUNTDOWN' || captureState === 'FLASH' || captureState === 'DEVELOPING' || (captureState === 'IDLE' && currentGesture === 'L_SHAPE'));

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', backgroundColor: '#000' }}>
      
      {/* 1. THREE.JS CANVAS LAYER */}
      <div ref={mountRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 1 }} />

      {/* 2. FLASH OVERLAY (Highest Z-Index) */}
      <div 
        className={`absolute inset-0 bg-white pointer-events-none transition-opacity duration-150 ${flash ? 'opacity-100' : 'opacity-0'}`} 
        style={{ zIndex: 3000 }} 
      />

      {/* 3. UI LAYER - TOP HEADER */}
      <div style={{ position: 'fixed', top: '2.5rem', left: 0, right: 0, zIndex: 1000, pointerEvents: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <h1 style={{ 
            fontFamily: '"Playfair Display", serif', 
            fontStyle: 'italic',
            fontWeight: 700,
            color: '#FFD700', // Gold
            textShadow: '0 0 15px rgba(255, 215, 0, 0.6), 0 4px 6px rgba(0,0,0,0.8)',
            letterSpacing: '0.05em'
          }} className="text-4xl md:text-7xl text-center uppercase">
            Merry Christmas
          </h1>
          <div className="h-[2px] w-48 bg-gradient-to-r from-transparent via-yellow-500 to-transparent mt-4 opacity-75" />
      </div>

      {visionStatusText && (
          <div className="fixed top-40 left-1/2 -translate-x-1/2 z-[1000] animate-pulse pointer-events-none">
              <div className="px-6 py-2 rounded-full bg-black/60 border border-yellow-500/30 backdrop-blur-sm text-yellow-400/80 text-xs tracking-[0.2em] font-bold shadow-[0_0_15px_rgba(255,215,0,0.1)]">
                  {visionStatusText}
              </div>
          </div>
      )}

      {errorMsg && (
          <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[1100] max-w-[90vw]">
              <div className="px-6 py-4 rounded bg-red-950/90 border border-red-500/50 backdrop-blur text-red-100 text-sm font-mono shadow-[0_0_20px_rgba(239,68,68,0.3)] flex flex-col items-center">
                  <span className="font-bold border-b border-red-500/50 mb-2 pb-1 w-full text-center tracking-widest">SYSTEM ALERT</span>
                  <span>{errorMsg}</span>
              </div>
          </div>
      )}

      {/* LOADING SCREEN */}
      {appMode === AppMode.LOADING && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 4000, backgroundColor: '#000', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
           <h1 className="text-3xl md:text-5xl text-yellow-400 tracking-[0.4em] mb-8 text-center drop-shadow-[0_0_15px_rgba(255,215,0,0.3)] uppercase animate-pulse font-serif">
             FROSTING THE NOEL...
           </h1>
           <div className="relative w-80 h-4 bg-gray-900 rounded-full overflow-hidden border border-gray-700 shadow-[0_0_15px_rgba(255,215,0,0.2)] mb-4">
              <div className="absolute top-0 left-0 h-full bg-gradient-to-r from-yellow-700 to-yellow-400 transition-all duration-300 ease-out" style={{ width: `${loadingProgress}%`}} />
           </div>
           <div className="flex flex-col items-center gap-2 text-yellow-500/80 font-mono text-sm tracking-widest">
             <span className="uppercase">{loadingStage}</span>
             <span className="text-white font-bold">{Math.round(loadingProgress)}%</span>
           </div>
        </div>
      )}

      {/* COUNTDOWN OVERLAY */}
      {captureState === 'COUNTDOWN' && countdown !== null && countdown > 0 && (
          <div className="fixed inset-0 flex items-center justify-center z-[2500] pointer-events-none">
              <div className="text-9xl text-white font-bold animate-ping drop-shadow-[0_4px_8px_rgba(0,0,0,0.8)]" style={{ textShadow: '0 0 30px gold' }}>{countdown}</div>
          </div>
      )}

      {/* CAMERA PREVIEW */}
      <div style={{ 
          position: 'fixed', inset: 0, 
          zIndex: 1050, 
          opacity: shouldShowCamera ? 1 : 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', 
          pointerEvents: 'none',
          transition: 'opacity 0.2s ease'
      }}>
            <div style={{ 
               width: '18rem', 
               aspectRatio: '1/1', 
               position: 'relative',
               overflow: 'hidden',
               boxShadow: '0 0 50px rgba(0,0,0,0.8)',
               border: '1px solid rgba(255,255,255,0.3)'
            }}>
                <video ref={videoRef} playsInline muted autoPlay style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
                <div className="absolute inset-4 border border-white/20"></div>
                <div className="absolute bottom-4 left-0 right-0 text-center text-white/90 font-cinzel text-xs font-bold tracking-widest uppercase drop-shadow-md">
                   {camMessage}
                </div>
                <div className="absolute bottom-0 left-0 right-0 h-1 bg-gray-800/50">
                   <div ref={holdBarRef} className="h-full bg-yellow-400 transition-all duration-75 ease-linear w-0" />
                </div>
            </div>
      </div>

      {/* DEVELOPING POLAROID */}
      {captureState === 'DEVELOPING' && (
         <div style={{ position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
           <div style={{ 
              width: '18rem',
              aspectRatio: '0.81', 
              backgroundColor: '#fdfbf7', 
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              padding: '1.2rem 1.2rem 3.5rem 1.2rem',
              boxShadow: '0 20px 50px rgba(0,0,0,0.8)',
              transform: 'scale(1)',
              animation: 'popIn 0.3s ease-out'
           }}>
               <div style={{ width: '100%', aspectRatio: '1/1', backgroundColor: '#050505', overflow: 'hidden', position: 'relative' }}>
                  {snapshotImage && (
                    <img 
                      src={snapshotImage} 
                      alt="Captured" 
                      style={{ 
                        width: '100%', height: '100%', objectFit: 'cover',
                        animation: 'fadeInPhoto 2s ease-in-out forwards'
                      }} 
                    />
                  )}
               </div>
               
               <div style={{ 
                  marginTop: 'auto', paddingTop: '0.5rem', textAlign: 'center', color: '#1f2937',
                  opacity: 0,
                  animation: 'fadeInText 1s ease-in-out 2s forwards' 
               }}>
                  <div className="font-cinzel text-2xl font-bold tracking-widest uppercase mb-1">VAVE</div>
                  <div className="font-cinzel text-[10px] tracking-widest uppercase">
                    {new Date().toLocaleDateString()} • {new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                  </div>
               </div>
           </div>
         </div>
      )}
      
      {/* BOTTOM MENU - ICONS - Centered */}
      <div style={{ position: 'absolute', bottom: '4rem', left: 0, right: 0, zIndex: 1000, pointerEvents: 'none', display: 'flex', justifyContent: 'center', gap: '2.5rem' }}>
          {/* SCATTER */}
          <div className={`flex flex-col items-center justify-center text-center transition-all duration-300 ${appMode === AppMode.SCATTER ? 'scale-110 opacity-100' : 'opacity-50'}`}>
              <div className="w-14 h-14 rounded-full bg-black/40 border border-yellow-500/80 flex items-center justify-center text-2xl backdrop-blur-md shadow-[0_0_25px_rgba(255,215,0,0.3)]">
                ✋
              </div>
              <span style={{ fontFamily: '"Cinzel", serif', letterSpacing: '0.1em' }} className="mt-2 text-[10px] font-bold text-yellow-400 uppercase drop-shadow-sm">Scatter</span>
          </div>

          {/* GATHER */}
          <div className={`flex flex-col items-center justify-center text-center transition-all duration-300 ${appMode === AppMode.TREE ? 'scale-110 opacity-100' : 'opacity-50'}`}>
              <div className="w-14 h-14 rounded-full bg-black/40 border border-yellow-500/80 flex items-center justify-center text-2xl backdrop-blur-md shadow-[0_0_25px_rgba(255,215,0,0.3)]">
                ✊
              </div>
              <span style={{ fontFamily: '"Cinzel", serif', letterSpacing: '0.1em' }} className="mt-2 text-[10px] font-bold text-yellow-400 uppercase drop-shadow-sm">Gather</span>
          </div>

          {/* CAPTURE - CLICKABLE */}
          <div 
             onClick={triggerCountdown}
             style={{ pointerEvents: 'auto', cursor: 'pointer' }}
             className={`flex flex-col items-center justify-center text-center transition-all duration-300 active:scale-95 ${captureState === 'COUNTDOWN' ? 'scale-125 opacity-100' : 'opacity-80 hover:opacity-100'}`}
          >
              <div className="w-16 h-16 rounded-full bg-black/40 border-2 border-white/80 flex items-center justify-center text-3xl backdrop-blur-md shadow-[0_0_25px_rgba(255,255,255,0.4)] hover:bg-white/10 transition-colors">
                👆
              </div>
              <span style={{ fontFamily: '"Cinzel", serif', letterSpacing: '0.2em' }} className="mt-2 text-xs font-bold text-white uppercase drop-shadow-sm">Snap</span>
          </div>

          {/* VAVE TEXT (THUMBS UP) */}
          <div className={`flex flex-col items-center justify-center text-center transition-all duration-300 ${appMode === AppMode.TEXT ? 'scale-110 opacity-100' : 'opacity-50'}`}>
              <div className="w-14 h-14 rounded-full bg-black/40 border border-yellow-500/80 flex items-center justify-center text-2xl backdrop-blur-md shadow-[0_0_25px_rgba(255,215,0,0.3)]">
                👍
              </div>
              <span style={{ fontFamily: '"Cinzel", serif', letterSpacing: '0.1em' }} className="mt-2 text-[10px] font-bold text-yellow-400 uppercase drop-shadow-sm">VAVE</span>
          </div>

          {/* RECALL */}
          <div className={`flex flex-col items-center justify-center text-center transition-all duration-300 ${currentGesture === 'PINCH' ? 'scale-110 opacity-100' : 'opacity-50'}`}>
              <div className="w-14 h-14 rounded-full bg-black/40 border border-yellow-500/80 flex items-center justify-center text-2xl backdrop-blur-md shadow-[0_0_25px_rgba(255,215,0,0.3)]">
                👌
              </div>
              <span style={{ fontFamily: '"Cinzel", serif', letterSpacing: '0.1em' }} className="mt-2 text-[10px] font-bold text-yellow-400 uppercase drop-shadow-sm">Recall</span>
          </div>
      </div>

      <style>{`
        @keyframes popIn {
          0% { transform: scale(0.9); opacity: 0; }
          50% { transform: scale(1.05); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes fadeInPhoto {
          0% { opacity: 0; filter: grayscale(1) blur(5px); }
          50% { opacity: 0.6; filter: grayscale(0.5) blur(2px); }
          100% { opacity: 1; filter: grayscale(0) blur(0); }
        }
        @keyframes fadeInText {
          from { opacity: 0; transform: translateY(5px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
};

export default App;