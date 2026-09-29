import * as THREE from 'three';
import './style.css';

type Racer = { group: THREE.Group; progress: number; speed: number; lane: number; color: number; name: string };
type Obstacle = { progress: number; lane: number; radius: number; hitRacers: Set<Racer>; warned: boolean };
type OncomingCar = { group: THREE.Group; progress: number; lane: number; baseLane: number; speed: number; active: boolean; warned: boolean; hitRacers: Set<Racer> };
type InputState = { pedal: boolean; brake: boolean; left: boolean; right: boolean; boost: boolean };
type PedalingLeg = {
  side: number;
  hip: THREE.Vector3;
  thigh: THREE.Mesh;
  shin: THREE.Mesh;
  knee: THREE.Mesh;
  shoe: THREE.Mesh;
  crankArm: THREE.Mesh;
  pedal: THREE.Mesh;
};
type RiderArm = { side: number; upper: THREE.Mesh; forearm: THREE.Mesh; elbow: THREE.Mesh; glove: THREE.Mesh };

const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')!;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#9ec9b3');
scene.fog = new THREE.FogExp2('#9ec9b3', 0.0085);
const camera = new THREE.PerspectiveCamera(57, window.innerWidth / window.innerHeight, 0.1, 600);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.16;

scene.add(new THREE.HemisphereLight('#e5f7ed', '#516755', 2.1));
const sun = new THREE.DirectionalLight('#fff3d7', 3.2);
sun.position.set(-55, 80, -30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -650; sun.shadow.camera.right = 650; sun.shadow.camera.top = 650; sun.shadow.camera.bottom = -650;
sun.shadow.camera.far = 1600;
scene.add(sun);

const TRACK_A = 430;
const TRACK_B = 285;
const ROAD_WIDTH = 11;
const FALL_SPEED = 60 / 3.6;
const FALL_DURATION = 5.5;
const TAU = Math.PI * 2;
const TRACK_SEGMENTS = 2048;
function trackCenter(angle: number): THREE.Vector3 {
  const radius = 1 + 0.08 * Math.sin(angle * 4 + 0.4) + 0.06 * Math.sin(angle * 9 - 1) + 0.025 * Math.sin(angle * 15 + 0.6);
  return new THREE.Vector3(
    Math.sin(angle) * TRACK_A * radius,
    Math.sin(angle * 2 + 0.7) * 1.5 + Math.sin(angle * 5 - 0.5) * 0.35,
    Math.cos(angle) * TRACK_B * radius,
  );
}
function trackDirection(angle: number): THREE.Vector3 {
  const radius = 1 + 0.08 * Math.sin(angle * 4 + 0.4) + 0.06 * Math.sin(angle * 9 - 1) + 0.025 * Math.sin(angle * 15 + 0.6);
  const derivative = 0.32 * Math.cos(angle * 4 + 0.4) + 0.54 * Math.cos(angle * 9 - 1) + 0.375 * Math.cos(angle * 15 + 0.6);
  return new THREE.Vector3(
    TRACK_A * (Math.cos(angle) * radius + Math.sin(angle) * derivative),
    0,
    TRACK_B * (-Math.sin(angle) * radius + Math.cos(angle) * derivative),
  ).normalize();
}
const trackArcLengths = new Float64Array(TRACK_SEGMENTS + 1);
let lastTrackPoint = trackCenter(0);
for (let i = 1; i <= TRACK_SEGMENTS; i++) {
  const angle = i / TRACK_SEGMENTS * TAU;
  const point = trackCenter(angle);
  trackArcLengths[i] = trackArcLengths[i - 1] + point.distanceTo(lastTrackPoint);
  lastTrackPoint = point;
}
const TRACK_LENGTH = trackArcLengths[TRACK_SEGMENTS];
const RACE_LENGTH = TRACK_LENGTH;
const RAMPS = [
  { start: 68, ascent: 38, drop: 13, rise: 5.2 },
  { start: 590, ascent: 42, drop: 15, rise: 5.8 },
  { start: 1210, ascent: 36, drop: 13, rise: 5.0 },
  { start: 1900, ascent: 44, drop: 16, rise: 6.0 },
];
function rampHeight(progress: number): number {
  const distance = (((progress % 1) + 1) % 1) * RACE_LENGTH;
  for (const ramp of RAMPS) {
    const along = distance - ramp.start;
    if (along >= 0 && along < ramp.ascent) return ramp.rise * along / ramp.ascent;
    if (along >= ramp.ascent && along < ramp.ascent + ramp.drop) return ramp.rise * (1 - (along - ramp.ascent) / ramp.drop);
  }
  return 0;
}
function trackAngle(progress: number): number {
  const wrapped = ((progress % 1) + 1) % 1;
  const target = wrapped * TRACK_LENGTH;
  let low = 0; let high = TRACK_SEGMENTS;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (trackArcLengths[middle] < target) low = middle; else high = middle;
  }
  const span = trackArcLengths[high] - trackArcLengths[low];
  const fraction = span === 0 ? 0 : (target - trackArcLengths[low]) / span;
  return (low + fraction) / TRACK_SEGMENTS * TAU;
}
const input: InputState = { pedal: false, brake: false, left: false, right: false, boost: false };
function clearInput(): void {
  for (const key of Object.keys(input) as (keyof InputState)[]) input[key] = false;
}
let state: 'ready' | 'countdown' | 'racing' | 'paused' | 'dead' | 'finished' = 'ready';
let countdown = 3;
let raceTime = 0;
let toastTimeout = 0;
let wasBoosting = false;
let previousPlace = 4;
let stamina = 100;
let lateral = -1.1;
let playerSpeed = 0;
let fallRemaining = 0;
let fallSide = 1;
let fallStartProgress = 0;
let fallStartLane = 0;
let fallRecoveryProgress = 0;
let fallRecoveryLane = 0;
let airborneY: number | null = null;
let verticalSpeed = 0;
let offRoadRemaining: number | null = null;
let offRoadExitProgress = 0;
let offRoadExitLane = 0;
let deathDisplayRemaining = 0;

const grassMaterial = new THREE.MeshStandardMaterial({ color: '#759778', roughness: 1 });
const terrainMaterial = new THREE.MeshStandardMaterial({ color: '#82a47d', roughness: 1 });
const roadMaterial = new THREE.MeshStandardMaterial({ color: '#424d4d', roughness: 0.92 });
const shoulderMaterial = new THREE.MeshStandardMaterial({ color: '#d0bd91', roughness: 1 });
const whiteMaterial = new THREE.MeshStandardMaterial({ color: '#f1ebd9', roughness: 0.9 });
const centerMaterial = new THREE.MeshStandardMaterial({ color: '#eee6c9', roughness: 0.9 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), grassMaterial);
ground.rotation.x = -Math.PI / 2; ground.position.y = -1.2; ground.receiveShadow = true; scene.add(ground);
const innerField = new THREE.Mesh(new THREE.CircleGeometry(39, 96), terrainMaterial);
innerField.rotation.x = -Math.PI / 2; innerField.position.y = -0.75;
innerField.scale.set((TRACK_A - 85) / 39, (TRACK_B - 85) / 39, 1); scene.add(innerField);

const trackPoint = (progress: number, lane = 0, heightOffset = 0): THREE.Vector3 => {
  const angle = trackAngle(progress);
  const center = trackCenter(angle);
  const tangent = trackDirection(angle);
  const normal = new THREE.Vector3(tangent.z, 0, -tangent.x);
  center.y += rampHeight(progress) + heightOffset;
  return center.addScaledVector(normal, lane);
};
const trackTangent = (progress: number) => {
  return trackDirection(trackAngle(progress));
};

function ribbon(width: number, material: THREE.Material, lift: number, segments = 960, from = 0, to = 1): THREE.Mesh {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const p = from + (to - from) * i / segments;
    const center = trackPoint(p, 0, lift);
    const tangent = trackTangent(p);
    const normal = new THREE.Vector3(tangent.z, 0, -tangent.x);
    const left = center.clone().addScaledVector(normal, width / 2);
    const right = center.clone().addScaledVector(normal, -width / 2);
    vertices.push(left.x, left.y, left.z, right.x, right.y, right.z);
    if (i < segments) { const j = i * 2; indices.push(j, j + 1, j + 2, j + 1, j + 3, j + 2); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material); mesh.receiveShadow = true; mesh.castShadow = false; return mesh;
}

scene.add(ribbon(ROAD_WIDTH + 2.5, shoulderMaterial, -0.04));
scene.add(ribbon(ROAD_WIDTH, roadMaterial, 0));
const rampMaterial = new THREE.MeshStandardMaterial({ color: '#59635d', roughness: 0.95 });
for (const ramp of RAMPS) {
  scene.add(ribbon(ROAD_WIDTH - 0.4, rampMaterial, 0.025, 32, ramp.start / RACE_LENGTH, (ramp.start + ramp.ascent) / RACE_LENGTH));
}
const embankmentMaterial = new THREE.MeshStandardMaterial({ color: '#688366', roughness: 1, side: THREE.DoubleSide });
for (const ramp of RAMPS) {
  const vertices: number[] = [];
  const indices: number[] = [];
  const segments = 36;
  for (const side of [-1, 1]) {
    const startIndex = vertices.length / 3;
    for (let i = 0; i <= segments; i++) {
      const progress = (ramp.start + (ramp.ascent + ramp.drop) * i / segments) / RACE_LENGTH;
      const edge = trackPoint(progress, side * (ROAD_WIDTH / 2 + 1.25), -0.05);
      const foot = trackPoint(progress, side * (ROAD_WIDTH / 2 + 5), -0.05);
      foot.y = Math.min(-1.18, edge.y - 0.05);
      vertices.push(edge.x, edge.y, edge.z, foot.x, foot.y, foot.z);
      if (i < segments) {
        const j = startIndex + i * 2;
        indices.push(j, j + 1, j + 2, j + 1, j + 3, j + 2);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  scene.add(new THREE.Mesh(geometry, embankmentMaterial));
}
scene.add(ribbon(0.18, whiteMaterial, 0.03, 960, 0.495, 0.505));

const dashGeometry = new THREE.BoxGeometry(0.16, 0.045, 2.4);
const dashCount = 240;
const dashes = new THREE.InstancedMesh(dashGeometry, centerMaterial, dashCount);
const dashTransform = new THREE.Object3D();
for (let i = 0; i < dashCount; i++) {
  const p = i / dashCount; const point = trackPoint(p, 0, 0.04); const tangent = trackTangent(p);
  dashTransform.position.copy(point); dashTransform.rotation.y = Math.atan2(tangent.x, tangent.z);
  dashTransform.updateMatrix(); dashes.setMatrixAt(i, dashTransform.matrix);
}
dashes.instanceMatrix.needsUpdate = true;
dashes.computeBoundingSphere();
scene.add(dashes);

const roadsidePostCount = 200;
const roadsidePosts = new THREE.InstancedMesh(
  new THREE.BoxGeometry(0.1, 1, 0.1),
  new THREE.MeshStandardMaterial({ color: '#f3eedb', roughness: 0.8 }),
  roadsidePostCount * 2,
);
const postReflectors = new THREE.InstancedMesh(
  new THREE.BoxGeometry(0.15, 0.14, 0.15),
  new THREE.MeshStandardMaterial({ color: '#d8f36a', roughness: 0.5 }),
  roadsidePostCount * 2,
);
const postTransform = new THREE.Object3D();
for (let i = 0; i < roadsidePostCount; i++) {
  for (const [sideIndex, side] of [-1, 1].entries()) {
    const progress = (i + sideIndex * 0.5) / roadsidePostCount;
    const point = trackPoint(progress, side * (ROAD_WIDTH / 2 + 1.1), 0.53);
    const index = i * 2 + sideIndex;
    postTransform.position.copy(point); postTransform.updateMatrix(); roadsidePosts.setMatrixAt(index, postTransform.matrix);
    postTransform.position.y += 0.39; postTransform.updateMatrix(); postReflectors.setMatrixAt(index, postTransform.matrix);
  }
}
roadsidePosts.instanceMatrix.needsUpdate = true;
postReflectors.instanceMatrix.needsUpdate = true;
roadsidePosts.computeBoundingSphere();
postReflectors.computeBoundingSphere();
scene.add(roadsidePosts, postReflectors);

function makeCyclist(color: number, accent = 0xf1dc9d): THREE.Group {
  const root = new THREE.Group();
  const bike = new THREE.Group();
  const rider = new THREE.Group();
  root.add(bike, rider);
  const tireMaterial = new THREE.MeshStandardMaterial({ color: '#202a2a', roughness: 0.85 });
  const rimMaterial = new THREE.MeshStandardMaterial({ color: '#ccd1c2', metalness: 0.5, roughness: 0.4 });
  const frameMaterial = new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.48 });
  const clothMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.72 });
  const shortsMaterial = new THREE.MeshStandardMaterial({ color: '#263b48', roughness: 0.8 });
  const skinMaterial = new THREE.MeshStandardMaterial({ color: '#d7a47e', roughness: 0.85 });
  const helmetMaterial = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.42 });
  const detailMaterial = new THREE.MeshStandardMaterial({ color: '#25363a', roughness: 0.65 });
  const wheelRadius = 0.57; const wheelZs = [-0.9, 0.9];
  const wheels: THREE.Group[] = [];
  for (const z of wheelZs) {
    const wheel = new THREE.Group(); wheel.position.set(0, wheelRadius, z);
    const tire = new THREE.Mesh(new THREE.TorusGeometry(wheelRadius, 0.055, 9, 28), tireMaterial); tire.rotation.y = Math.PI / 2; wheel.add(tire);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(wheelRadius - 0.09, 0.018, 6, 28), rimMaterial); rim.rotation.y = Math.PI / 2; wheel.add(rim);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.17, 10), rimMaterial); hub.rotation.z = Math.PI / 2; wheel.add(hub);
    for (let spoke = 0; spoke < 8; spoke++) {
      const angle = spoke * Math.PI / 4;
      const radial = new THREE.Vector3(0, Math.cos(angle), Math.sin(angle));
      const spokeLength = wheelRadius - 0.09;
      const line = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, spokeLength, 5), rimMaterial);
      line.position.copy(radial).multiplyScalar(spokeLength / 2);
      line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), radial);
      wheel.add(line);
    }
    bike.add(wheel); wheels.push(wheel);
  }
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const tube = (a: THREE.Vector3, b: THREE.Vector3, radius: number, material: THREE.Material, parent = bike) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 8), material);
    mesh.position.copy(a).add(b).multiplyScalar(0.5); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()); mesh.castShadow = true; parent.add(mesh);
  };
  const rear = v(0, wheelRadius, -0.9), front = v(0, wheelRadius, 0.9), crank = v(0, wheelRadius + 0.07, -0.13), seat = v(0, wheelRadius + 0.78, -0.2), head = v(0, wheelRadius + 0.77, 0.48), stem = v(0, wheelRadius + 0.89, 0.58);
  tube(rear, crank, 0.055, frameMaterial); tube(crank, seat, 0.055, frameMaterial); tube(seat, rear, 0.055, frameMaterial); tube(seat, head, 0.06, frameMaterial); tube(head, crank, 0.055, frameMaterial); tube(head, front, 0.045, frameMaterial); tube(head, stem, 0.045, frameMaterial);
  tube(v(-0.37, stem.y, stem.z), v(0.37, stem.y, stem.z), 0.035, tireMaterial);
  tube(v(0, seat.y, seat.z - 0.22), v(0, seat.y + 0.05, seat.z + 0.12), 0.055, tireMaterial);
  const pedalAxle = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.17, 10), rimMaterial); pedalAxle.rotation.z = Math.PI / 2; pedalAxle.position.copy(crank); bike.add(pedalAxle);
  const legs: PedalingLeg[] = [];
  for (const side of [-1, 1]) {
    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.09, 1, 10), shortsMaterial);
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.05, 1, 10), skinMaterial);
    const knee = new THREE.Mesh(new THREE.SphereGeometry(0.083, 10, 8), skinMaterial);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.13, 0.34), detailMaterial);
    const crankArm = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 1, 8), rimMaterial);
    const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.04, 0.24), tireMaterial);
    for (const part of [thigh, shin, knee, shoe]) { part.castShadow = true; rider.add(part); }
    for (const part of [crankArm, pedal]) { part.castShadow = true; bike.add(part); }
    legs.push({ side, hip: v(side * 0.16, seat.y + 0.06, seat.z - 0.12), thigh, shin, knee, shoe, crankArm, pedal });
  }
  const hips = new THREE.Mesh(new THREE.SphereGeometry(0.23, 12, 8), shortsMaterial);
  hips.scale.set(1.18, 0.72, 0.9); hips.position.set(0, seat.y + 0.08, seat.z - 0.11); hips.castShadow = true; rider.add(hips);
  const torso = new THREE.Group();
  torso.position.set(0, seat.y + 0.03, seat.z - 0.11); torso.rotation.x = 0.55; rider.add(torso);
  const jersey = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.21, 0.67, 10), clothMaterial);
  jersey.scale.z = 0.7; jersey.position.y = 0.38; jersey.castShadow = true; torso.add(jersey);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.11, 10), shortsMaterial);
  collar.position.y = 0.77; collar.castShadow = true; torso.add(collar);
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 11), skinMaterial);
  headMesh.scale.set(0.9, 1.1, 0.95); headMesh.position.set(0, 0.99, 0.02); headMesh.castShadow = true; torso.add(headMesh);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.13, 6), skinMaterial);
  nose.rotation.x = Math.PI / 2; nose.position.set(0, 0.99, 0.23); torso.add(nose);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), skinMaterial);
    ear.position.set(side * 0.185, 0.99, 0.015); torso.add(ear);
  }
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.225, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.57), helmetMaterial);
  helmet.position.set(0, 1.05, 0.02); helmet.castShadow = true; torso.add(helmet);
  for (const side of [-1, 1]) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.018, 0.2), detailMaterial);
    vent.position.set(side * 0.095, 1.255, 0.03); torso.add(vent);
  }
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.065), detailMaterial);
  visor.position.set(0, 1.045, 0.205); torso.add(visor);
  const arms: RiderArm[] = [-1, 1].map((side) => {
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.075, 1, 9), clothMaterial);
    const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.067, 0.055, 1, 9), skinMaterial);
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.073, 9, 7), skinMaterial);
    const glove = new THREE.Mesh(new THREE.SphereGeometry(0.08, 9, 7), detailMaterial);
    for (const part of [upper, forearm, elbow, glove]) { part.castShadow = true; rider.add(part); }
    return { side, upper, forearm, elbow, glove };
  });
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.86, 20), new THREE.MeshBasicMaterial({ color: '#23302a', transparent: true, opacity: 0.17, depthWrite: false })); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.03; root.add(shadow);
  root.userData.wheels = wheels; root.userData.torso = torso; root.userData.shadow = shadow;
  root.userData.bike = bike; root.userData.rider = rider; root.userData.arms = arms;
  root.userData.legs = legs; root.userData.crank = crank; root.userData.pedalPhase = 0; root.userData.steeringVisual = 0;
  poseCyclist(root, 0);
  poseArms(root);
  return root;
}

const segmentAxis = new THREE.Vector3(0, 1, 0);
function setSegment(mesh: THREE.Mesh, start: THREE.Vector3, end: THREE.Vector3): void {
  const direction = end.clone().sub(start);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.scale.y = direction.length();
  mesh.quaternion.setFromUnitVectors(segmentAxis, direction.normalize());
}
function poseCyclist(group: THREE.Group, phase: number): void {
  const legs = group.userData.legs as PedalingLeg[];
  const crank = group.userData.crank as THREE.Vector3;
  for (const leg of legs) {
    const angle = phase + (leg.side === 1 ? Math.PI : 0);
    const pin = new THREE.Vector3(leg.side * 0.32, crank.y + Math.cos(angle) * 0.22, crank.z + Math.sin(angle) * 0.22);
    const foot = pin.clone().add(new THREE.Vector3(0, 0.07, 0.04));
    const dy = foot.y - leg.hip.y;
    const dz = foot.z - leg.hip.z;
    const distance = Math.hypot(dy, dz);
    const bend = Math.sqrt(Math.max(0, 0.56 ** 2 - (distance / 2) ** 2));
    const knee = new THREE.Vector3(
      leg.side * 0.24,
      (leg.hip.y + foot.y) / 2 + dz / distance * bend,
      (leg.hip.z + foot.z) / 2 - dy / distance * bend,
    );
    setSegment(leg.thigh, leg.hip, knee);
    setSegment(leg.shin, knee, foot);
    setSegment(leg.crankArm, new THREE.Vector3(leg.side * 0.16, crank.y, crank.z), pin);
    leg.knee.position.copy(knee);
    leg.shoe.position.copy(foot);
    leg.pedal.position.copy(pin);
  }
}
function poseArms(group: THREE.Group, standing = 0, support = 0, reaching = 0, fallSide = 1): void {
  const torso = group.userData.torso as THREE.Group;
  const arms = group.userData.arms as RiderArm[];
  for (const arm of arms) {
    const shoulder = new THREE.Vector3(arm.side * 0.27, 0.65, 0).applyEuler(torso.rotation).add(torso.position);
    const hand = new THREE.Vector3(arm.side * 0.31, 1.48, 0.58)
      .lerp(new THREE.Vector3(arm.side * 0.31, 1.05, -0.08), standing)
      .lerp(new THREE.Vector3(arm.side * 0.3, 0.5, 0.48), support)
      .lerp(new THREE.Vector3(fallSide * 0.56 + arm.side * 0.15, 1.07, 0.2), reaching);
    const elbow = shoulder.clone().lerp(hand, 0.52).add(new THREE.Vector3(arm.side * 0.1, -0.06, -0.04));
    setSegment(arm.upper, shoulder, elbow);
    setSegment(arm.forearm, elbow, hand);
    arm.elbow.position.copy(elbow);
    arm.glove.position.copy(hand);
  }
}

function addTree(x: number, z: number, scale: number, pine: boolean, y = 0): void {
  const group = new THREE.Group(); group.position.set(x, y, z); group.scale.setScalar(scale);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.27, 2.3, 6), new THREE.MeshStandardMaterial({ color: '#74543e', roughness: 1 })); trunk.position.y = 1.15; trunk.castShadow = true; group.add(trunk);
  if (pine) {
    const mat = new THREE.MeshStandardMaterial({ color: ['#355f4d', '#426e55', '#4c765a'][Math.floor(Math.random() * 3)], roughness: 1 });
    for (let layer = 0; layer < 3; layer++) { const crown = new THREE.Mesh(new THREE.ConeGeometry(1.45 - layer * 0.2, 2.5, 7), mat); crown.position.y = 2.2 + layer * 0.98; crown.castShadow = true; group.add(crown); }
  } else {
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.6, 1), new THREE.MeshStandardMaterial({ color: '#5d805c', roughness: 1 })); crown.position.y = 3.2; crown.scale.y = 0.9; crown.castShadow = true; group.add(crown);
  }
  scene.add(group);
}

for (let i = 0; i < 190; i++) {
  const a = Math.random() * TAU; const ring = 84 + Math.random() * 72;
  addTree(Math.sin(a) * (TRACK_A + ring), Math.cos(a) * (TRACK_B + ring), 0.75 + Math.random() * 1.05, Math.random() > 0.13);
}
for (let i = 0; i < 27; i++) {
  const point = trackPoint(Math.random(), ROAD_WIDTH / 2 + 23 + Math.random() * 18);
  addTree(point.x, point.z, 0.65 + Math.random() * 0.55, Math.random() > 0.2, point.y - 0.1);
}
for (let i = 0; i < 120; i++) {
  const progress = i / 120 + (Math.random() - 0.5) / 120;
  const side = i % 2 === 0 ? 1 : -1;
  const point = trackPoint(progress, side * (ROAD_WIDTH / 2 + 5 + Math.random() * 14));
  addTree(point.x, point.z, 0.65 + Math.random() * 0.45, true, point.y - 0.1);
}

const racers: Racer[] = [];
const player = makeCyclist(0xd4ed60, 0x28392c);
const playerShadow = player.userData.shadow as THREE.Mesh;
player.remove(playerShadow); scene.add(playerShadow);
const startProgress = 0;
const playerRacer: Racer = { group: player, progress: startProgress, speed: 0, lane: -1.1, color: 0xd4ed60, name: 'YOU' };
racers.push(playerRacer); scene.add(player);
const rivalSpecs = [
  { color: 0xe57d5c, lane: -3.7, progress: 0.008, speed: 19.6, name: 'MAYA' },
  { color: 0x71b8c2, lane: 0.9, progress: 0.001, speed: 20.2, name: 'NOAH' },
  { color: 0xd3c8aa, lane: 3.6, progress: -0.009, speed: 18.7, name: 'ELI' },
];
const rivals = rivalSpecs.map((spec) => {
  const group = makeCyclist(spec.color, 0xf1dca8); const racer: Racer = { group, progress: spec.progress, speed: spec.speed, lane: spec.lane, color: spec.color, name: spec.name };
  scene.add(group); racers.push(racer); return racer;
});

function makeOncomingCar(color: number): THREE.Group {
  const group = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.25, roughness: 0.48 });
  const glass = new THREE.MeshStandardMaterial({ color: '#84aeb0', metalness: 0.3, roughness: 0.2 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#242a2a', roughness: 0.9 });
  const light = new THREE.MeshBasicMaterial({ color: '#fff3bb' });
  const tailLight = new THREE.MeshBasicMaterial({ color: '#e84e45' });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.58, 3.7), paint);
  body.position.y = 0.72; body.castShadow = true; group.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.68, 1.95), glass);
  cabin.position.set(0, 1.28, -0.24); cabin.castShadow = true; group.add(cabin);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.54, 0.13, 1.98), paint);
  roof.position.set(0, 1.67, -0.24); roof.castShadow = true; group.add(roof);
  for (const x of [-0.68, 0.68]) {
    for (const z of [-1.2, 1.2]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.24, 12), rubber);
      wheel.rotation.z = Math.PI / 2; wheel.position.set(x < 0 ? -0.96 : 0.96, 0.43, z);
      wheel.castShadow = true; group.add(wheel);
    }
    const headlamp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.18, 0.05), light);
    headlamp.position.set(x, 0.78, 1.88); group.add(headlamp);
    const rearLamp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.05), tailLight);
    rearLamp.position.set(x, 0.78, -1.88); group.add(rearLamp);
  }
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 4.1), new THREE.MeshBasicMaterial({ color: '#1d2c28', transparent: true, opacity: 0.18, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.04; group.add(shadow);
  group.visible = false;
  return group;
}
const oncomingCars: OncomingCar[] = [0xd8e0d7, 0x4c7b9a, 0xb66b58].map((color) => {
  const group = makeOncomingCar(color); scene.add(group);
  return { group, progress: 0, lane: 0, baseLane: 0, speed: 0, active: false, warned: false, hitRacers: new Set<Racer>() };
});
let nextCarIn = 5 + Math.random() * 3;
function spawnOncomingCar(): void {
  const car = oncomingCars.find((candidate) => !candidate.active);
  if (!car) return;
  const lanes = [-2.7, 0, 2.7];
  const leadProgress = Math.max(...racers.map((racer) => racer.progress));
  car.progress = Math.max(playerRacer.progress + (130 + Math.random() * 60) / RACE_LENGTH, leadProgress + (90 + Math.random() * 40) / RACE_LENGTH);
  car.baseLane = lanes[Math.floor(Math.random() * lanes.length)] + (Math.random() - 0.5) * 0.5;
  car.lane = car.baseLane;
  car.speed = 13 + Math.random() * 5;
  car.active = true; car.warned = false; car.hitRacers.clear(); car.group.visible = true;
}

const obstacleOrange = new THREE.MeshStandardMaterial({ color: '#ed713d', roughness: 0.8 });
const obstacleWhite = new THREE.MeshStandardMaterial({ color: '#f5eee0', roughness: 0.8 });
const obstacleDark = new THREE.MeshStandardMaterial({ color: '#353d38', roughness: 0.95 });
const obstacles: Obstacle[] = [];
const obstacleLanes = [-1.1, 2.7, 0.9, -3.1, 1.8, 0, -2.5, 3, -0.4];
for (let i = 0; i < 18; i++) {
  const progress = (115 + i * 125) / RACE_LENGTH;
  const lane = obstacleLanes[i % obstacleLanes.length];
  const barrier = i % 3 === 1;
  const group = new THREE.Group();
  if (barrier) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.16, 0.55), obstacleDark);
    base.position.y = 0.08; group.add(base);
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.72, 0.38), obstacleOrange);
    body.position.y = 0.5; body.castShadow = true; group.add(body);
    for (const y of [0.34, 0.66]) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.1, 0.4), obstacleWhite);
      stripe.position.y = y; group.add(stripe);
    }
  } else {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.1, 0.85), obstacleDark);
    base.position.y = 0.05; group.add(base);
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.38, 1.15, 10), obstacleOrange);
    cone.position.y = 0.65; cone.castShadow = true; group.add(cone);
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.25, 0.16, 10), obstacleWhite);
    stripe.position.y = 0.81; group.add(stripe);
  }
  group.position.copy(trackPoint(progress, lane, 0.03));
  const tangent = trackTangent(progress);
  group.rotation.y = Math.atan2(tangent.x, tangent.z);
  scene.add(group);
  obstacles.push({ progress, lane, radius: barrier ? 1.05 : 0.43, hitRacers: new Set(), warned: false });
}

const startGate = new THREE.Group();
const gateMat = new THREE.MeshStandardMaterial({ color: '#ebe6d6', roughness: 0.5 });
for (const x of [-6.1, 6.1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 4.2, 0.25), gateMat); post.position.set(x, 2.1, 0); startGate.add(post); }
const beam = new THREE.Mesh(new THREE.BoxGeometry(12.4, 0.28, 0.3), new THREE.MeshStandardMaterial({ color: '#d9ed6e', roughness: 0.4 })); beam.position.y = 4.15; startGate.add(beam);
const banner = new THREE.Mesh(new THREE.BoxGeometry(8, 1.05, 0.16), new THREE.MeshStandardMaterial({ color: '#243d32', roughness: 0.6 })); banner.position.set(0, 3.38, -0.06); startGate.add(banner);
startGate.position.copy(trackPoint(0, 0, 0));
const startTangent = trackTangent(0);
startGate.rotation.y = Math.atan2(startTangent.x, startTangent.z); scene.add(startGate);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const timerEl = $('timer'); const speedEl = $('speed'); const positionEl = $('position'); const progressEl = $('progress-label');
const progressFill = $('progress-fill'); const staminaFill = $('stamina-fill'); const staminaValue = $('stamina-value'); const boostState = $('boost-state');
const startOverlay = $('start-overlay'); const pauseOverlay = $('pause-overlay'); const resultOverlay = $('result-overlay');
const toastEl = $('toast'); const racerMarkers = $('racer-markers');
const offRoadWarning = $('offroad-warning'); const offRoadSeconds = $('offroad-seconds'); const deathOverlay = $('death-overlay');
const windLayer = $('wind-layer'); const soundButton = $('sound-button');
const mapCoordinates = (point: THREE.Vector3) => ({ x: 100 + point.x / TRACK_A * 82, y: 75 - point.z / TRACK_B * 54 });
const mapRoute = Array.from({ length: 193 }, (_, i) => {
  const point = mapCoordinates(trackPoint(i / 192));
  return `${i === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
}).join(' ') + ' Z';
document.querySelector<SVGPathElement>('#minimap-route')!.setAttribute('d', mapRoute);
const mapMarkers = document.querySelector<SVGGElement>('#minimap-markers')!;
const mapDots = racers.map((racer, i) => {
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.classList.add('minimap-marker');
  if (i === 0) dot.classList.add('player');
  dot.setAttribute('r', i === 0 ? '5.5' : '3.8');
  dot.setAttribute('fill', `#${racer.color.toString(16).padStart(6, '0')}`);
  mapMarkers.append(dot);
  return dot;
});
mapMarkers.append(mapDots[0]);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
for (let i = 0; i < 14; i++) {
  const streak = document.createElement('i');
  const right = i >= 7;
  streak.className = right ? 'right' : 'left';
  streak.style.left = right ? `${97 - (i - 7) * 4}%` : `${3 + i * 4}%`;
  streak.style.top = `${(i * 29 + 11) % 84}%`;
  streak.style.animationDelay = `-${(i % 5) * 0.16}s`;
  streak.style.animationDuration = `${0.58 + (i % 4) * 0.11}s`;
  windLayer.append(streak);
}
let soundEnabled = true;
let windAudio: AudioContext | null = null;
let windFilter: BiquadFilterNode | null = null;
let windGain: GainNode | null = null;
for (let i = 0; i < racers.length; i++) { const marker = document.createElement('i'); marker.className = `racer-marker${i === 0 ? ' player' : ''}`; marker.id = `marker-${i}`; racerMarkers.append(marker); }

function ensureWindAudio(): void {
  if (!window.AudioContext) return;
  if (windAudio) { void windAudio.resume(); return; }
  windAudio = new AudioContext();
  const buffer = windAudio.createBuffer(1, windAudio.sampleRate, windAudio.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  const source = windAudio.createBufferSource(); source.buffer = buffer; source.loop = true;
  windFilter = windAudio.createBiquadFilter(); windFilter.type = 'lowpass'; windFilter.frequency.value = 350;
  windGain = windAudio.createGain(); windGain.gain.value = 0;
  source.connect(windFilter); windFilter.connect(windGain); windGain.connect(windAudio.destination);
  source.start();
  void windAudio.resume();
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60); const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(2).padStart(5, '0')}`;
}
function notify(message: string, locked = false): void {
  toastEl.textContent = message; toastEl.classList.add('visible');
  window.clearTimeout(toastTimeout); if (!locked) toastTimeout = window.setTimeout(() => toastEl.classList.remove('visible'), 1350);
}
function setState(next: typeof state): void {
  state = next; document.body.classList.toggle('paused', state === 'paused'); document.body.classList.toggle('racing', state === 'racing');
}
function resetRace(): void {
  raceTime = 0; stamina = 100; playerSpeed = 0; lateral = -1.1; countdown = 3; previousPlace = 4; wasBoosting = false;
  fallRemaining = 0; airborneY = null; verticalSpeed = 0;
  offRoadRemaining = null; deathDisplayRemaining = 0; offRoadWarning.classList.add('hidden'); deathOverlay.classList.add('hidden');
  obstacles.forEach((obstacle) => { obstacle.hitRacers.clear(); obstacle.warned = false; });
  nextCarIn = 5 + Math.random() * 3;
  oncomingCars.forEach((car) => { car.active = false; car.group.visible = false; car.hitRacers.clear(); });
  playerRacer.progress = startProgress; playerRacer.lane = -1.1; playerRacer.speed = 0;
  rivals.forEach((racer, i) => { racer.progress = rivalSpecs[i].progress; racer.speed = rivalSpecs[i].speed; racer.lane = rivalSpecs[i].lane; });
  racers.forEach((racer) => {
    racer.group.userData.pedalPhase = 0;
    racer.group.userData.steeringVisual = 0;
    racer.group.rotation.z = 0;
    (racer.group.userData.bike as THREE.Group).position.set(0, 0, 0);
    (racer.group.userData.bike as THREE.Group).rotation.set(0, 0, 0);
    (racer.group.userData.rider as THREE.Group).position.set(0, 0, 0);
    (racer.group.userData.rider as THREE.Group).rotation.set(0, 0, 0);
    (racer.group.userData.torso as THREE.Group).rotation.set(0.55, 0, 0);
    (racer.group.userData.wheels as THREE.Group[]).forEach((wheel) => { wheel.rotation.x = 0; });
    poseCyclist(racer.group, 0);
    poseArms(racer.group);
  });
  startOverlay.classList.add('hidden'); pauseOverlay.classList.add('hidden'); resultOverlay.classList.add('hidden');
  $('bottom-hint').classList.remove('hidden'); notify('3', true); setState('countdown');
  clearInput();
}
function finishRace(): void {
  setState('finished'); resultOverlay.classList.remove('hidden'); $('bottom-hint').classList.add('hidden');
  const place = getPlace(); const placeNames = ['', '冲线！', '紧随其后', '再快一点', '下一圈更快'];
  $('result-title').textContent = placeNames[place] ?? '比赛完成'; $('result-place').textContent = String(place); $('result-time').textContent = formatTime(raceTime);
  $('result-kicker').textContent = place === 1 ? '冠军' : '比赛完成';
  const oldBest = Number(localStorage.getItem('velo-rush-best') ?? 0);
  const best = oldBest === 0 || raceTime < oldBest ? raceTime : oldBest;
  localStorage.setItem('velo-rush-best', String(best)); $('best-time').textContent = formatTime(best);
  if (best === raceTime) $('result-kicker').textContent = '个人最佳 · 新纪录';
}
function getPlace(): number {
  return 1 + racers.filter((racer) => racer !== playerRacer && racer.progress > playerRacer.progress).length;
}
function startRace(): void { if (soundEnabled) ensureWindAudio(); resetRace(); }
function pauseRace(): void {
  if (state === 'racing' || state === 'countdown') { clearInput(); setState('paused'); pauseOverlay.classList.remove('hidden'); }
  else if (state === 'paused') { setState('racing'); pauseOverlay.classList.add('hidden'); }
}
function bindHold(button: HTMLElement, key: keyof InputState): void {
  const down = (event: Event) => { event.preventDefault(); input[key] = true; button.classList.add('pressed'); };
  const up = () => { input[key] = false; button.classList.remove('pressed'); };
  button.addEventListener('pointerdown', down); button.addEventListener('pointerup', up); button.addEventListener('pointercancel', up); button.addEventListener('pointerleave', up);
}
window.addEventListener('keydown', (event) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) event.preventDefault();
  if (event.repeat && event.key === 'Escape') return;
  if (event.key === 'w' || event.key === 'W' || event.key === 'ArrowUp') input.pedal = true;
  if (event.key === 's' || event.key === 'S' || event.key === 'ArrowDown') input.brake = true;
  if (event.key === 'a' || event.key === 'A' || event.key === 'ArrowLeft') input.left = true;
  if (event.key === 'd' || event.key === 'D' || event.key === 'ArrowRight') input.right = true;
  if (event.key === 'Shift') input.boost = true;
  if (event.key === 'Escape' || event.key.toLowerCase() === 'p') pauseRace();
  if (state === 'ready' && (event.key === 'Enter' || event.key === ' ')) startRace();
});
window.addEventListener('keyup', (event) => {
  if (event.key === 'w' || event.key === 'W' || event.key === 'ArrowUp') input.pedal = false;
  if (event.key === 's' || event.key === 'S' || event.key === 'ArrowDown') input.brake = false;
  if (event.key === 'a' || event.key === 'A' || event.key === 'ArrowLeft') input.left = false;
  if (event.key === 'd' || event.key === 'D' || event.key === 'ArrowRight') input.right = false;
  if (event.key === 'Shift') input.boost = false;
});
window.addEventListener('blur', clearInput);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  clearInput();
  if (windAudio && windGain) windGain.gain.setTargetAtTime(0, windAudio.currentTime, 0.08);
});
$('start-button').addEventListener('click', startRace); $('again-button').addEventListener('click', startRace);
$('resume-button').addEventListener('click', pauseRace); $('pause-button').addEventListener('click', pauseRace);
$('restart-button').addEventListener('click', startRace);
soundButton.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  soundButton.textContent = soundEnabled ? '◖))' : '◖×';
  soundButton.setAttribute('aria-pressed', String(soundEnabled));
  soundButton.setAttribute('aria-label', soundEnabled ? '关闭风声' : '开启风声');
  soundButton.title = soundEnabled ? '关闭风声' : '开启风声';
  if (soundEnabled) ensureWindAudio();
});
document.querySelectorAll<HTMLElement>('.mobile-controls button').forEach((button) => {
  const control = button.dataset.control;
  if (control === 'pedal') bindHold(button, 'pedal'); else if (control === 'boost') bindHold(button, 'boost');
  else if (control === 'left') bindHold(button, 'left'); else if (control === 'right') bindHold(button, 'right');
});

function updateRacer(racer: Racer, delta: number): void {
  const progress = ((racer.progress % 1) + 1) % 1;
  const point = trackPoint(progress, racer.lane, 0.07);
  const tangent = trackTangent(progress);
  racer.group.position.copy(point);
  const moving = state === 'racing';
  const steering = racer === playerRacer ? Number(input.left) - Number(input.right) : 0;
  if (moving) racer.group.userData.steeringVisual = THREE.MathUtils.damp(racer.group.userData.steeringVisual as number, steering, 7, delta);
  const visualSteering = racer.group.userData.steeringVisual as number;
  const speedFactor = THREE.MathUtils.clamp(racer.speed / 10, 0, 1);
  racer.group.rotation.y = Math.atan2(tangent.x, tangent.z) + visualSteering * speedFactor * 0.11;
  const slopeSample = 1.2 / RACE_LENGTH;
  const beforeHeight = trackPoint(progress - slopeSample, racer.lane).y;
  const afterHeight = trackPoint(progress + slopeSample, racer.lane).y;
  racer.group.rotation.x = -Math.atan2(afterHeight - beforeHeight, 2.4);
  if (moving) {
    const sample = 0.001;
    const before = trackTangent(progress - sample);
    const after = trackTangent(progress + sample);
    const turnAngle = Math.atan2(before.z * after.x - before.x * after.z, before.x * after.x + before.z * after.z);
    const curvature = turnAngle / (sample * 2 * TRACK_LENGTH);
    const naturalLean = Math.atan(racer.speed ** 2 * curvature / 9.81);
    const targetLean = THREE.MathUtils.clamp(-(naturalLean + visualSteering * speedFactor * 0.32), -0.53, 0.53);
    racer.group.rotation.z = THREE.MathUtils.damp(racer.group.rotation.z, targetLean, 5, delta);
    const torso = racer.group.userData.torso as THREE.Group;
    torso.rotation.z = THREE.MathUtils.damp(torso.rotation.z, targetLean * 0.2, 5, delta);
  }
  const wheels = racer.group.userData.wheels as THREE.Group[];
  wheels.forEach((wheel) => { if (moving) wheel.rotation.x += racer.speed * delta / 0.57; });
  const pedaling = moving && (racer !== playerRacer || (input.pedal && !input.brake));
  if (pedaling) racer.group.userData.pedalPhase += Math.min(12, 2.6 + racer.speed * 0.36) * delta;
  poseCyclist(racer.group, racer.group.userData.pedalPhase as number);
  if (racer !== playerRacer) poseArms(racer.group);
}

const clock = new THREE.Clock();
function tick(): void {
  requestAnimationFrame(tick);
  const delta = Math.min(clock.getDelta(), 0.04);
  if (state === 'countdown') {
    countdown -= delta;
    const shown = Math.ceil(countdown);
    if (shown !== Math.ceil(countdown + delta)) notify(String(Math.max(1, shown)), true);
    if (countdown <= 0) { setState('racing'); toastEl.classList.remove('visible'); }
  }
  if (state === 'dead') {
    deathDisplayRemaining -= delta;
    if (deathDisplayRemaining <= 0) {
      playerRacer.progress = offRoadExitProgress;
      playerRacer.lane = offRoadExitLane;
      lateral = offRoadExitLane;
      playerSpeed = 0;
      playerRacer.speed = 0;
      airborneY = null; verticalSpeed = 0;
      clearInput();
      deathOverlay.classList.add('hidden');
      setState('racing');
      notify('已从离开赛道处重生');
    }
  }
  if (state === 'racing') {
    raceTime += delta;
    const previousLane = playerRacer.lane;
    const previousProgress = playerRacer.progress;
    if (fallRemaining > 0) {
      fallRemaining = Math.max(0, fallRemaining - delta);
      playerSpeed = 0; playerRacer.speed = 0; wasBoosting = false; clearInput();
      const recovery = THREE.MathUtils.smoothstep(FALL_DURATION - fallRemaining, 4.7, FALL_DURATION);
      playerRacer.progress = THREE.MathUtils.lerp(fallStartProgress, fallRecoveryProgress, recovery);
      playerRacer.lane = THREE.MathUtils.lerp(fallStartLane, fallRecoveryLane, recovery);
      lateral = playerRacer.lane;
      if (fallRemaining === 0) toastEl.classList.remove('visible');
    } else {
      const boosting = input.pedal && input.boost && stamina > 0.4;
      const targetAcceleration = input.pedal ? (boosting ? 12 : 5.1) : -1.45;
      playerSpeed = THREE.MathUtils.clamp(playerSpeed + targetAcceleration * delta, 0, boosting ? 30 : 24);
      if (input.brake) playerSpeed = Math.max(0, playerSpeed - 11 * delta);
      if (boosting) stamina = Math.max(0, stamina - 24 * delta);
      else stamina = Math.min(100, stamina + (input.pedal ? 3.4 : 8.5) * delta);
      if (boosting !== wasBoosting && boosting && airborneY === null) notify('冲刺启动', false);
      wasBoosting = boosting;
      const steering = Number(input.left) - Number(input.right);
      const laneChangeRate = Math.min(2.5, playerSpeed * 0.11);
      lateral += steering * laneChangeRate * delta;
      playerRacer.lane = THREE.MathUtils.damp(playerRacer.lane, lateral, 4.5, delta);
      playerRacer.speed = playerSpeed;
      playerRacer.progress += playerSpeed * delta / RACE_LENGTH;
      const roadY = trackPoint(playerRacer.progress, playerRacer.lane, 0.07).y;
      if (airborneY !== null) {
        verticalSpeed -= 9.81 * delta;
        airborneY += verticalSpeed * delta;
        if (airborneY <= roadY && verticalSpeed < 0) {
          airborneY = null; verticalSpeed = 0;
          notify('平稳落地');
        }
      } else if (playerSpeed >= 11) {
        for (const ramp of RAMPS) {
          const lip = (ramp.start + ramp.ascent) / RACE_LENGTH;
          if (previousProgress < lip && playerRacer.progress >= lip) {
            airborneY = trackPoint(lip, playerRacer.lane, 0.07).y;
            verticalSpeed = playerSpeed * ramp.rise / ramp.ascent;
            notify('飞坡！');
            break;
          }
        }
      }
    }
    nextCarIn -= delta;
    if (nextCarIn <= 0) { spawnOncomingCar(); nextCarIn = 7 + Math.random() * 6; }
    for (const car of oncomingCars) {
      if (!car.active) continue;
      car.progress -= car.speed * delta / RACE_LENGTH;
      const approachingObstacle = obstacles.find((obstacle) => {
        const distance = (car.progress - obstacle.progress) * RACE_LENGTH;
        return distance > -3 && distance < 42 && Math.abs(car.baseLane - obstacle.lane) < obstacle.radius + 1.1;
      });
      const leftLane = THREE.MathUtils.clamp(car.baseLane - 2.7, -3.8, 3.8);
      const rightLane = THREE.MathUtils.clamp(car.baseLane + 2.7, -3.8, 3.8);
      const targetLane = approachingObstacle
        ? Math.abs(leftLane - approachingObstacle.lane) > Math.abs(rightLane - approachingObstacle.lane) ? leftLane : rightLane
        : car.baseLane;
      car.lane = THREE.MathUtils.damp(car.lane, targetLane, 3, delta);
      car.group.position.copy(trackPoint(car.progress, car.lane, 0.06));
      const tangent = trackTangent(car.progress);
      car.group.rotation.y = Math.atan2(-tangent.x, -tangent.z);
    }
    rivals.forEach((racer, i) => {
      const target = rivalSpecs[i].speed + Math.sin(raceTime * (0.42 + i * 0.1) + i) * 1.1;
      racer.speed = THREE.MathUtils.damp(racer.speed, target, 0.6, delta);
      racer.progress += racer.speed * delta / RACE_LENGTH;
      const baseLane = rivalSpecs[i].lane;
      const approachingObstacle = obstacles.find((obstacle) => {
        const distance = (obstacle.progress - racer.progress) * RACE_LENGTH;
        return distance > -2 && distance < 43 && Math.abs(baseLane - obstacle.lane) < obstacle.radius + 0.8;
      });
      let hazardLane: number | null = approachingObstacle?.lane ?? null;
      let hazardDistance = approachingObstacle ? (approachingObstacle.progress - racer.progress) * RACE_LENGTH : Infinity;
      let dodgeWidth = 2.4;
      for (const car of oncomingCars) {
        if (!car.active) continue;
        const distance = (car.progress - racer.progress) * RACE_LENGTH;
        if (distance > -3 && distance < 70 && distance < hazardDistance && Math.abs(baseLane - car.lane) < 1.8) {
          hazardLane = car.lane; hazardDistance = distance; dodgeWidth = 2.7;
        }
      }
      const leftLane = THREE.MathUtils.clamp(baseLane - dodgeWidth, -3.8, 3.8);
      const rightLane = THREE.MathUtils.clamp(baseLane + dodgeWidth, -3.8, 3.8);
      const safeLane = hazardLane !== null
        ? Math.abs(leftLane - hazardLane) > Math.abs(rightLane - hazardLane) ? leftLane : rightLane
        : baseLane + Math.sin(raceTime * 0.65 + i * 2) * 0.32;
      racer.lane = THREE.MathUtils.damp(racer.lane, safeLane, 3.8, delta);
    });
    for (const obstacle of obstacles) {
      const distanceAhead = (obstacle.progress - playerRacer.progress) * RACE_LENGTH;
      if (!obstacle.warned && distanceAhead > 0 && distanceAhead < 46 && Math.abs(playerRacer.lane - obstacle.lane) < obstacle.radius + 0.9) {
        obstacle.warned = true;
        notify('前方障碍 · 左右转向避开');
      }
      for (const racer of racers) {
        if (obstacle.hitRacers.has(racer)) continue;
        if (Math.abs(obstacle.progress - racer.progress) * RACE_LENGTH > 1.6) continue;
        if (Math.abs(obstacle.lane - racer.lane) > obstacle.radius + 0.4) continue;
        if (racer === playerRacer && airborneY !== null) continue;
        obstacle.hitRacers.add(racer);
        racer.speed *= 0.5;
        if (racer === playerRacer) {
          if (playerSpeed >= FALL_SPEED) {
            fallRemaining = FALL_DURATION;
            fallSide = Math.sign(playerRacer.lane - obstacle.lane) || (Math.random() < 0.5 ? -1 : 1);
            fallStartProgress = playerRacer.progress; fallStartLane = playerRacer.lane;
            fallRecoveryProgress = Math.min(playerRacer.progress, obstacle.progress - 2.4 / RACE_LENGTH);
            fallRecoveryLane = THREE.MathUtils.clamp(obstacle.lane + fallSide * (obstacle.radius + 1.1), -4.5, 4.5);
            if (Math.abs(fallRecoveryLane - obstacle.lane) < obstacle.radius + 0.7) {
              fallSide *= -1;
              fallRecoveryLane = THREE.MathUtils.clamp(obstacle.lane + fallSide * (obstacle.radius + 1.1), -4.5, 4.5);
            }
            playerSpeed = 0; racer.speed = 0; wasBoosting = false; clearInput();
            airborneY = null; verticalSpeed = 0;
            stamina = Math.max(0, stamina - 20);
            notify('撞击过猛 · 摔倒了', true);
          } else {
            playerSpeed = racer.speed;
            stamina = Math.max(0, stamina - 12);
            notify('撞上障碍 · 减速');
          }
        }
      }
    }
    for (const car of oncomingCars) {
      if (!car.active) continue;
      const distanceAhead = (car.progress - playerRacer.progress) * RACE_LENGTH;
      if (fallRemaining === 0 && !car.warned && distanceAhead > 0 && distanceAhead < 75 && Math.abs(car.lane - playerRacer.lane) < 1.9) {
        car.warned = true;
        notify('对向来车 · 注意避让');
      }
      for (const racer of racers) {
        if (racer === playerRacer && fallRemaining > 0) continue;
        if (car.hitRacers.has(racer)) continue;
        if (Math.abs(car.progress - racer.progress) * RACE_LENGTH > 2.6) continue;
        if (Math.abs(car.lane - racer.lane) > 1.4) continue;
        if (racer === playerRacer && airborneY !== null && airborneY - trackPoint(racer.progress, racer.lane, 0.07).y > 1.5) continue;
        car.hitRacers.add(racer);
        racer.speed *= 0.3;
        if (racer === playerRacer) {
          playerSpeed = racer.speed;
          stamina = Math.max(0, stamina - 20);
          notify('撞上对向汽车 · 大幅减速');
        }
      }
      if (distanceAhead < -80) { car.active = false; car.group.visible = false; }
    }
    const roadEdge = ROAD_WIDTH / 2;
    const outsideRoad = Math.abs(playerRacer.lane) > roadEdge;
    if (outsideRoad && offRoadRemaining === null) {
      const crossing = (roadEdge - Math.abs(previousLane)) / (Math.abs(playerRacer.lane) - Math.abs(previousLane));
      offRoadExitProgress = THREE.MathUtils.lerp(previousProgress, playerRacer.progress, crossing);
      offRoadExitLane = Math.sign(playerRacer.lane) * (roadEdge - 0.7);
      offRoadRemaining = 5;
      offRoadWarning.classList.remove('hidden');
    }
    if (offRoadRemaining !== null) {
      if (!outsideRoad) {
        offRoadRemaining = null;
        offRoadWarning.classList.add('hidden');
      } else {
        offRoadRemaining = Math.max(0, offRoadRemaining - delta);
        offRoadSeconds.textContent = String(Math.ceil(offRoadRemaining));
        if (offRoadRemaining === 0) {
          offRoadRemaining = null;
          deathDisplayRemaining = 1.5;
          offRoadWarning.classList.add('hidden');
          deathOverlay.classList.remove('hidden');
          toastEl.classList.remove('visible');
          airborneY = null; verticalSpeed = 0;
          clearInput();
          setState('dead');
        }
      }
    }
    if (state === 'racing') {
      if (!outsideRoad && playerRacer.progress >= 1) { playerRacer.progress = 1; finishRace(); }
      const place = getPlace();
      if (place < previousPlace) notify(`超越对手 · 第 ${place} 名`);
      previousPlace = place;
    }
  }
  racers.forEach((racer) => updateRacer(racer, delta));
  playerShadow.position.copy(trackPoint(playerRacer.progress, playerRacer.lane, 0.03));
  const flightHeight = airborneY === null ? 0 : Math.max(0, airborneY - trackPoint(playerRacer.progress, playerRacer.lane, 0.07).y);
  playerShadow.scale.setScalar(1 - Math.min(0.45, flightHeight * 0.05));
  if (airborneY !== null) {
    player.position.y = airborneY;
    player.rotation.x = -Math.atan2(verticalSpeed, Math.max(playerSpeed, 1));
  }
  const bike = player.userData.bike as THREE.Group;
  const rider = player.userData.rider as THREE.Group;
  bike.position.set(0, 0, 0); bike.rotation.set(0, 0, 0);
  rider.position.set(0, 0, 0); rider.rotation.set(0, 0, 0);
  let standing = 0;
  let reaching = 0;
  let support = 0;
  let walking = 0;
  if (fallRemaining > 0) {
    const time = FALL_DURATION - fallRemaining;
    const impact = THREE.MathUtils.smoothstep(time, 0, 0.4);
    const rise = THREE.MathUtils.smoothstep(time, 0.9, 2.1);
    const approach = THREE.MathUtils.smoothstep(time, 2.1, 2.9);
    const lift = THREE.MathUtils.smoothstep(time, 2.9, 4.0);
    const mount = THREE.MathUtils.smoothstep(time, 4.1, 5.3);
    standing = THREE.MathUtils.smoothstep(time, 0.7, 1.8) * (1 - mount);
    reaching = approach * (1 - mount);
    support = THREE.MathUtils.smoothstep(time, 0.55, 0.95) * (1 - THREE.MathUtils.smoothstep(time, 1.25, 1.85));
    walking = Math.sin((time - 2.1) * Math.PI * 2 / 0.8) * approach * (1 - lift);
    player.rotation.z = 0;
    bike.rotation.z = fallSide * 1.25 * impact * (1 - lift);
    bike.position.y = 0.23 * impact * (1 - lift);
    rider.rotation.z = fallSide * 1.35 * impact * (1 - rise);
    rider.position.set(
      -fallSide * (1.45 * impact - 0.85 * approach - 0.6 * mount),
      0.35 * impact * (1 - rise),
      0.9 * impact - 0.6 * approach - 0.3 * mount,
    );
  }
  const torso = player.userData.torso as THREE.Group;
  torso.rotation.x = 0.55 * (1 - standing) + 0.45 * support;
  const legs = player.userData.legs as PedalingLeg[];
  for (const leg of legs) {
    if (standing > 0) {
      const step = leg.side * walking;
      const standingKnee = new THREE.Vector3(leg.side * 0.22 + fallSide * step * 0.05, 0.82, -0.28)
        .lerp(new THREE.Vector3(leg.side * 0.28, 0.58, 0.16), support);
      const standingFoot = new THREE.Vector3(leg.side * 0.24 + fallSide * step * 0.13, 0.13 + Math.max(0, step) * 0.09, -0.22)
        .lerp(new THREE.Vector3(leg.side * 0.25, 0.13, -0.45), support);
      const knee = leg.knee.position.clone().lerp(standingKnee, standing);
      const foot = leg.shoe.position.clone().lerp(standingFoot, standing);
      setSegment(leg.thigh, leg.hip, knee);
      setSegment(leg.shin, knee, foot);
      leg.knee.position.copy(knee);
      leg.shoe.position.copy(foot);
    }
  }
  poseArms(player, standing, support, reaching, fallSide);
  const playerPoint = player.position;
  const tangent = trackTangent(playerRacer.progress);
  const speedSense = THREE.MathUtils.clamp(playerSpeed / 24, 0, 1);
  const cameraTarget = playerPoint.clone().add(new THREE.Vector3(0, 2.05, 0)).addScaledVector(tangent, speedSense * 2);
  const cameraDistance = THREE.MathUtils.lerp(8.8, 6.6, speedSense);
  const cameraHeight = THREE.MathUtils.lerp(4.9, 3.6, speedSense);
  const cameraPosition = playerPoint.clone().addScaledVector(tangent, -cameraDistance).add(new THREE.Vector3(0, cameraHeight, 0));
  const windIntensity = state === 'racing' ? THREE.MathUtils.clamp((playerSpeed - 5) / 25, 0, 1) : 0;
  windLayer.style.opacity = String(windIntensity * (wasBoosting ? 0.85 : 0.65));
  if (windAudio && windGain && windFilter) {
    const now = windAudio.currentTime;
    windGain.gain.setTargetAtTime(soundEnabled && !document.hidden ? windIntensity * (wasBoosting ? 0.09 : 0.07) : 0, now, 0.08);
    windFilter.frequency.setTargetAtTime(350 + windIntensity * 1700, now, 0.08);
  }
  camera.position.lerp(cameraPosition, 1 - Math.exp(-5 * delta));
  if (!reducedMotion) {
    const shake = windIntensity * (wasBoosting ? 0.035 : 0.018);
    camera.position.x += Math.sin(raceTime * 37) * shake;
    camera.position.y += Math.sin(raceTime * 43) * shake;
  }
  camera.lookAt(cameraTarget);
  camera.fov = THREE.MathUtils.damp(camera.fov, 57 + speedSense * 16 + (wasBoosting ? 3 : 0), 2.8, delta); camera.updateProjectionMatrix();
  speedEl.textContent = String(Math.round(playerSpeed * 3.6));
  timerEl.textContent = formatTime(raceTime);
  positionEl.textContent = String(getPlace());
  const normalized = Math.min(playerRacer.progress, 1); const percent = Math.floor(normalized * 100);
  progressEl.textContent = `${percent}%`; progressFill.style.width = `${percent}%`;
  racers.forEach((racer, i) => {
    const marker = $<HTMLElement>(`marker-${i}`);
    marker.style.left = `${Math.min(100, Math.max(0, racer.progress * 100))}%`;
    const point = mapCoordinates(racer.group.position);
    mapDots[i].setAttribute('cx', String(THREE.MathUtils.clamp(point.x, 5, 195)));
    mapDots[i].setAttribute('cy', String(THREE.MathUtils.clamp(point.y, 5, 145)));
  });
  staminaFill.style.width = `${stamina}%`; staminaValue.textContent = `${Math.round(stamina)}%`;
  boostState.textContent = stamina < 8 ? '恢复中' : input.boost ? 'BOOST' : 'READY';
  const ticks = document.querySelectorAll<HTMLElement>('.speed-ticks i'); const activeTicks = Math.round(playerSpeed / 30 * ticks.length);
  ticks.forEach((tickEl, i) => tickEl.classList.toggle('active', i < activeTicks));
  renderer.render(scene, camera);
}

function onResize(): void { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75)); renderer.setSize(window.innerWidth, window.innerHeight); }
window.addEventListener('resize', onResize);
updateRacer(playerRacer, 0); rivals.forEach((racer) => updateRacer(racer, 0));
const initialPoint = trackPoint(startProgress, -1.1, 0); const initialTangent = trackTangent(startProgress);
camera.position.copy(initialPoint).addScaledVector(initialTangent, -8.8).add(new THREE.Vector3(0, 5, 0)); camera.lookAt(initialPoint.clone().add(new THREE.Vector3(0, 2.1, 0)));
tick();
