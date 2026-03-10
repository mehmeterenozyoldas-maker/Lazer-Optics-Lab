import React, { useState, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PivotControls, Grid, MeshTransmissionMaterial, Environment, MeshReflectorMaterial, Sparkles, ContactShadows } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette, DepthOfField, Noise, ChromaticAberration, wrapEffect } from '@react-three/postprocessing';
import { Effect } from 'postprocessing';
import * as THREE from 'three';
import { Trash2, Settings2, Box, Triangle, MoveRight } from 'lucide-react';

const gaussianBlurFragmentShader = `
uniform float amount;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec4 color = vec4(0.0);
    float total = 0.0;
    
    // Simple 5x5 Gaussian blur approximation
    for(float x = -2.0; x <= 2.0; x++) {
        for(float y = -2.0; y <= 2.0; y++) {
            vec2 offset = vec2(x, y) * amount;
            float weight = exp(-(x*x + y*y) / 2.0);
            color += texture2D(inputBuffer, uv + offset) * weight;
            total += weight;
        }
    }
    
    outputColor = color / total;
}
`;

class GaussianBlurEffectImpl extends Effect {
    constructor({ amount = 0.002 } = {}) {
        super('GaussianBlurEffect', gaussianBlurFragmentShader, {
            uniforms: new Map([['amount', new THREE.Uniform(amount)]])
        });
    }
}

const GaussianBlur = wrapEffect(GaussianBlurEffectImpl);

type SceneObject = {
    id: string;
    type: 'emitter' | 'prism' | 'mirror';
    position: [number, number, number];
    rotation: [number, number, number];
};

function refract(I: THREE.Vector3, N: THREE.Vector3, eta: number) {
    const dotNI = N.dot(I);
    const k = 1.0 - eta * eta * (1.0 - dotNI * dotNI);
    if (k < 0.0) return null;
    return I.clone().multiplyScalar(eta).sub(N.clone().multiplyScalar(eta * dotNI + Math.sqrt(k))).normalize();
}

const LaserBeam = ({ p1, p2 }: { p1: THREE.Vector3, p2: THREE.Vector3 }) => {
    const materialRef = useRef<THREE.ShaderMaterial>(null);
    const distance = p1.distanceTo(p2);
    const position = p1.clone().lerp(p2, 0.5);
    const direction = p2.clone().sub(p1).normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);

    useFrame((state) => {
        if (materialRef.current) {
            materialRef.current.uniforms.time.value = state.clock.elapsedTime;
        }
    });

    const uniforms = useMemo(() => ({
        time: { value: 0 },
        color: { value: new THREE.Color(8, 1, 1) } // Hotter red for AAA bloom
    }), []);

    return (
        <group position={position} quaternion={quaternion}>
            {/* Glow with custom AAA shader */}
            <mesh>
                <cylinderGeometry args={[0.08, 0.08, distance, 16]} />
                <shaderMaterial 
                    ref={materialRef}
                    transparent
                    depthWrite={false}
                    blending={THREE.AdditiveBlending}
                    uniforms={uniforms}
                    vertexShader={`
                        varying vec2 vUv;
                        void main() {
                            vUv = uv;
                            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                        }
                    `}
                    fragmentShader={`
                        uniform float time;
                        uniform vec3 color;
                        varying vec2 vUv;
                        void main() {
                            float pulse = sin(vUv.y * 40.0 - time * 30.0) * 0.15 + 0.85;
                            float edge = 1.0 - abs(vUv.x - 0.5) * 2.0;
                            float core = pow(edge, 8.0) * 2.0; // Intense hot core
                            float glow = pow(edge, 2.0) * 0.6; // Soft outer glow
                            float alpha = (core + glow) * pulse;
                            gl_FragColor = vec4(color * alpha * 1.5, alpha);
                        }
                    `}
                />
            </mesh>
            {/* Core */}
            <mesh>
                <cylinderGeometry args={[0.01, 0.01, distance, 8]} />
                <meshBasicMaterial color={[20, 10, 10]} toneMapped={false} />
            </mesh>
            {/* Volumetric light at the hit point (end of the segment) */}
            <pointLight distance={3} intensity={3} color="#ff2222" position={[0, distance/2, 0]} />
        </group>
    );
};

const Lasers = () => {
    const { scene, camera } = useThree();
    const [allPoints, setAllPoints] = useState<THREE.Vector3[][]>([]);
    const raycaster = useMemo(() => new THREE.Raycaster(), []);
    
    useFrame(() => {
        raycaster.camera = camera;
        
        const newAllPoints: THREE.Vector3[][] = [];
        
        const emitterObjects: THREE.Object3D[] = [];
        scene.traverse((child) => {
            if (child.userData?.isEmitter) {
                emitterObjects.push(child);
            }
        });
        
        emitterObjects.forEach(emitterObj => {
            const startPos = new THREE.Vector3();
            emitterObj.getWorldPosition(startPos);
            
            const startDir = new THREE.Vector3(1, 0, 0);
            startDir.transformDirection(emitterObj.matrixWorld).normalize();
            
            startPos.add(startDir.clone().multiplyScalar(0.2));
            
            const newPoints = [startPos.clone()];
            let currentPos = startPos.clone();
            let currentDir = startDir.clone();
            
            for (let i = 0; i < 15; i++) {
                raycaster.set(currentPos, currentDir);
                const intersects = raycaster.intersectObjects(scene.children, true);
                
                const validHits = intersects.filter(hit => 
                    hit.object.userData && 
                    (hit.object.userData.isMirror || hit.object.userData.isPrism) && 
                    hit.distance > 0.001
                );
                
                if (validHits.length > 0) {
                    const hit = validHits[0];
                    newPoints.push(hit.point.clone());
                    
                    let N = hit.face?.normal?.clone().transformDirection(hit.object.matrixWorld).normalize();
                    if (!N) break;
                    
                    if (hit.object.userData.isMirror) {
                        currentDir.reflect(N);
                        currentPos = hit.point.clone().add(currentDir.clone().multiplyScalar(0.001));
                    } else if (hit.object.userData.isPrism) {
                        let isEntering = currentDir.dot(N) < 0;
                        if (!isEntering) N.negate();
                        
                        const eta = isEntering ? (1.0 / 1.5) : (1.5 / 1.0);
                        const refracted = refract(currentDir, N, eta);
                        
                        if (refracted) {
                            currentDir = refracted;
                        } else {
                            currentDir.reflect(N); // TIR
                        }
                        currentPos = hit.point.clone().add(currentDir.clone().multiplyScalar(0.001));
                    }
                } else {
                    newPoints.push(currentPos.clone().add(currentDir.clone().multiplyScalar(20)));
                    break;
                }
            }
            newAllPoints.push(newPoints);
        });
        
        let changed = newAllPoints.length !== allPoints.length;
        if (!changed) {
            for (let i = 0; i < newAllPoints.length; i++) {
                if (newAllPoints[i].length !== allPoints[i].length) {
                    changed = true;
                    break;
                }
                for (let j = 0; j < newAllPoints[i].length; j++) {
                    if (newAllPoints[i][j].distanceTo(allPoints[i][j]) > 0.001) {
                        changed = true;
                        break;
                    }
                }
                if (changed) break;
            }
        }
        
        if (changed) {
            setAllPoints(newAllPoints);
        }
    });
    
    return (
        <group>
            {allPoints.map((points, idx) => (
                <group key={idx}>
                    {points.map((p, i) => {
                        if (i === points.length - 1) return null;
                        return <LaserBeam key={i} p1={p} p2={points[i+1]} />
                    })}
                </group>
            ))}
        </group>
    );
}

const Prism = ({ initialPosition, initialRotation }: { initialPosition: [number, number, number], initialRotation: [number, number, number] }) => {
    return (
        <PivotControls anchor={[0, -1, 0]} depthTest={false} lineWidth={2} scale={1}>
            <group position={initialPosition} rotation={initialRotation}>
                <mesh userData={{ isPrism: true }} castShadow receiveShadow>
                    <cylinderGeometry args={[1, 1, 2, 3]} />
                    <MeshTransmissionMaterial 
                        backside
                        samples={8}
                        thickness={1.5}
                        chromaticAberration={0.4}
                        anisotropy={0.3}
                        distortion={0.2}
                        distortionScale={0.2}
                        temporalDistortion={0.1}
                        ior={1.5}
                        color="#ffffff"
                        transmission={1}
                        clearcoat={1}
                        clearcoatRoughness={0.1}
                    />
                </mesh>
            </group>
        </PivotControls>
    )
}

const Mirror = ({ initialPosition, initialRotation }: { initialPosition: [number, number, number], initialRotation: [number, number, number] }) => {
    return (
        <PivotControls anchor={[0, -1, 0]} depthTest={false} lineWidth={2} scale={1}>
            <group position={initialPosition} rotation={initialRotation}>
                <mesh userData={{ isMirror: true }} position={[0, 0, 0]} castShadow receiveShadow>
                    <boxGeometry args={[1.5, 1, 0.1]} />
                    <meshStandardMaterial color="#ffffff" metalness={1} roughness={0.02} />
                </mesh>
                <mesh position={[0, -0.5, 0]} castShadow receiveShadow>
                    <cylinderGeometry args={[0.05, 0.05, 1]} />
                    <meshStandardMaterial color="#111111" metalness={0.9} roughness={0.4} />
                </mesh>
                <mesh position={[0, -1, 0]} castShadow receiveShadow>
                    <cylinderGeometry args={[0.3, 0.3, 0.1]} />
                    <meshStandardMaterial color="#111111" metalness={0.9} roughness={0.4} />
                </mesh>
            </group>
        </PivotControls>
    )
}

const Table = () => (
    <group position={[0, 0, 0]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
            <planeGeometry args={[50, 50]} />
            <MeshReflectorMaterial
                blur={[400, 100]}
                resolution={1024}
                mixBlur={1}
                mixStrength={15}
                roughness={0.6}
                depthScale={1.2}
                minDepthThreshold={0.4}
                maxDepthThreshold={1.4}
                color="#0a0a0a"
                metalness={0.8}
                mirror={0.4}
            />
        </mesh>
        <Grid infiniteGrid fadeDistance={20} sectionColor="#444444" cellColor="#1a1a1a" sectionSize={2} cellSize={0.5} position={[0, 0, 0]} />
    </group>
)

const Emitter = ({ initialPosition, initialRotation }: { initialPosition: [number, number, number], initialRotation: [number, number, number] }) => (
    <PivotControls anchor={[0, -0.5, 0]} depthTest={false} lineWidth={2} scale={1}>
        <group position={initialPosition} rotation={initialRotation} userData={{ isEmitter: true }}>
            <mesh position={[-0.5, 0, 0]} castShadow>
                <boxGeometry args={[1, 0.5, 0.5]} />
                <meshPhysicalMaterial color="#1a1a1a" metalness={0.9} roughness={0.2} clearcoat={0.5} />
            </mesh>
            <mesh position={[0.01, 0, 0]} rotation={[0, 0, -Math.PI/2]} castShadow>
                <cylinderGeometry args={[0.1, 0.1, 0.2]} />
                <meshStandardMaterial color="#050505" metalness={1} roughness={0.1} />
            </mesh>
            <mesh position={[-0.5, -0.5, 0]} castShadow>
                <cylinderGeometry args={[0.1, 0.1, 1]} />
                <meshStandardMaterial color="#1a1a1a" metalness={0.9} roughness={0.2} />
            </mesh>
        </group>
    </PivotControls>
)

export default function App() {
    const [objects, setObjects] = useState<SceneObject[]>([
        { id: '1', type: 'emitter', position: [-4, 1, 0], rotation: [0, 0, 0] },
        { id: '2', type: 'prism', position: [0, 1, 0], rotation: [0, 0, 0] },
        { id: '3', type: 'mirror', position: [3, 1, -2], rotation: [0, -Math.PI / 4, 0] },
        { id: '4', type: 'mirror', position: [-1, 1, 3], rotation: [0, Math.PI / 4, 0] },
        { id: '5', type: 'mirror', position: [4, 1, 3], rotation: [0, Math.PI / 2, 0] },
    ]);

    const addObject = (type: 'emitter' | 'prism' | 'mirror') => {
        setObjects([...objects, {
            id: Math.random().toString(36).substring(7),
            type,
            position: [0, 1, 0],
            rotation: [0, 0, 0]
        }]);
    };

    const removeObject = (id: string) => {
        setObjects(objects.filter(o => o.id !== id));
    };

    return (
        <div className="w-full h-screen bg-black overflow-hidden font-sans">
            <div className="absolute top-0 left-0 p-8 text-white pointer-events-none z-10">
                <h1 className="text-4xl font-bold mb-2 tracking-tight drop-shadow-lg">Optics Lab <span className="text-red-500 text-sm align-top">AAA</span></h1>
                <p className="text-white/60 max-w-md drop-shadow-md">
                    Cinematic laser simulation. Drag the colored rings to rotate and move the prism and mirrors.
                </p>
            </div>
            
            <div className="absolute top-0 right-0 p-8 w-80 max-h-screen overflow-y-auto pointer-events-auto z-10 flex flex-col gap-4">
                <div className="bg-black/40 backdrop-blur-xl border border-white/10 p-4 rounded-2xl shadow-2xl">
                    <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                        <Settings2 className="w-5 h-5" /> Design Mode
                    </h2>
                    
                    <div className="grid grid-cols-3 gap-2 mb-6">
                        <button onClick={() => addObject('emitter')} className="flex flex-col items-center gap-2 p-3 bg-white/5 hover:bg-white/10 rounded-xl text-white/80 transition-colors cursor-pointer border border-white/5 hover:border-white/20">
                            <MoveRight className="w-5 h-5 text-red-500" />
                            <span className="text-xs font-medium">Laser</span>
                        </button>
                        <button onClick={() => addObject('prism')} className="flex flex-col items-center gap-2 p-3 bg-white/5 hover:bg-white/10 rounded-xl text-white/80 transition-colors cursor-pointer border border-white/5 hover:border-white/20">
                            <Triangle className="w-5 h-5 text-blue-400" />
                            <span className="text-xs font-medium">Prism</span>
                        </button>
                        <button onClick={() => addObject('mirror')} className="flex flex-col items-center gap-2 p-3 bg-white/5 hover:bg-white/10 rounded-xl text-white/80 transition-colors cursor-pointer border border-white/5 hover:border-white/20">
                            <Box className="w-5 h-5 text-gray-400" />
                            <span className="text-xs font-medium">Mirror</span>
                        </button>
                    </div>

                    <div className="space-y-2">
                        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">Scene Objects</h3>
                        {objects.map(obj => (
                            <div key={obj.id} className="flex items-center justify-between p-3 bg-black/40 rounded-xl border border-white/5">
                                <div className="flex items-center gap-3">
                                    {obj.type === 'emitter' && <MoveRight className="w-4 h-4 text-red-500" />}
                                    {obj.type === 'prism' && <Triangle className="w-4 h-4 text-blue-400" />}
                                    {obj.type === 'mirror' && <Box className="w-4 h-4 text-gray-400" />}
                                    <span className="text-sm text-white capitalize">{obj.type}</span>
                                </div>
                                <button onClick={() => removeObject(obj.id)} className="p-1.5 hover:bg-red-500/20 text-white/40 hover:text-red-400 rounded-lg transition-colors cursor-pointer">
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                        ))}
                        {objects.length === 0 && (
                            <p className="text-sm text-white/40 text-center py-4">No objects in scene</p>
                        )}
                    </div>
                </div>
            </div>
            
            <Canvas shadows camera={{ position: [0, 8, 10], fov: 45 }} gl={{ antialias: false, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.2 }}>
                <color attach="background" args={['#020202']} />
                <fog attach="fog" args={['#020202', 10, 30]} />
                
                <ambientLight intensity={0.1} />
                <spotLight position={[5, 10, 5]} intensity={40} color="#ffaa55" castShadow angle={0.5} penumbra={1} shadow-mapSize={[2048, 2048]} shadow-bias={-0.0001} />
                <pointLight position={[-5, 5, -5]} intensity={15} color="#55aaff" />
                
                {/* AAA Grounding Shadows */}
                <ContactShadows position={[0, 0.01, 0]} opacity={0.8} scale={20} blur={2} far={2} resolution={512} color="#000000" />
                
                {/* Atmospheric Dust */}
                <Sparkles count={400} scale={15} size={1.5} speed={0.1} opacity={0.15} color="#ffbbaa" />
                
                <Table />
                
                {objects.map(obj => {
                    if (obj.type === 'emitter') return <Emitter key={obj.id} initialPosition={obj.position} initialRotation={obj.rotation} />
                    if (obj.type === 'prism') return <Prism key={obj.id} initialPosition={obj.position} initialRotation={obj.rotation} />
                    if (obj.type === 'mirror') return <Mirror key={obj.id} initialPosition={obj.position} initialRotation={obj.rotation} />
                    return null;
                })}
                
                <Lasers />
                
                <OrbitControls makeDefault maxPolarAngle={Math.PI / 2 - 0.05} minDistance={2} maxDistance={20} />
                
                <EffectComposer multisampling={0}>
                    <GaussianBlur amount={0.002} />
                    <DepthOfField focusDistance={0.02} focalLength={0.05} bokehScale={4} height={480} />
                    <Bloom luminanceThreshold={0.5} mipmapBlur intensity={2.0} />
                    <ChromaticAberration offset={new THREE.Vector2(0.002, 0.002)} />
                    <Noise opacity={0.03} />
                    <Vignette eskil={false} offset={0.1} darkness={1.2} />
                </EffectComposer>
                
                <Environment preset="studio" />
            </Canvas>
        </div>
    )
}

