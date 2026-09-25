/* motor3d.js — Kit Webs 3D
   Objetos 3D reales (GLB) controlados por el scroll, sin build.
   Arranca solo al encontrar [data-motor3d]. Ver motor3d.css para el layout.
   Dependencias (via importmap del index.html): three, gsap, gsap/ScrollTrigger, lenis.

   Un objeto estrella (data-modelo) y, opcionalmente, más objetos (data-objetos):
   otros modelos GLB, el logo del negocio en volumen, copias del objeto estrella en
   otros colores, partículas de ambiente y formas flotantes. Cada sección describe
   en data-3d el estado del objeto estrella y, en "objetos", el de los demás. */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';

gsap.registerPlugin(ScrollTrigger);

const avisar = (...args) => console.warn('[motor3d]', ...args);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const RAD = Math.PI / 180;
// Carpeta de los decodificadores Draco, en el mismo CDN que three (mismas versiones del importmap)
const RUTA_DRACO = 'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/gltf/';

/* ---------- Entorno ---------- */
const reducido = matchMedia('(prefers-reduced-motion: reduce)').matches;
// ?captura=1 en la URL: todo el contenido visible desde el principio (para capturas de página completa)
const captura = new URLSearchParams(location.search).has('captura');
const tactil = matchMedia('(pointer: coarse)').matches;
const movil = () => innerWidth < 820;
const pocaPotencia = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory ?? 8) <= 4;
const hayWebGL2 = (() => {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGL2RenderingContext && c.getContext('webgl2'));
  } catch { return false; }
})();

/* ---------- Objetos adicionales (data-objetos) ---------- */
const TIPOS_OBJETO = ['glb', 'logo', 'copia', 'particulas', 'formas'];
const AMBIENTE = (tipo) => tipo === 'particulas' || tipo === 'formas';

function leerDefiniciones(main) {
  const crudo = main.dataset.objetos;
  if (!crudo) return [];
  let lista;
  try { lista = JSON.parse(crudo); }
  catch (e) { avisar(`data-objetos no es JSON válido: ${e.message}. Se ignoran los objetos adicionales.`); return []; }
  if (!Array.isArray(lista)) { avisar('data-objetos tiene que ser una lista [...]. Se ignora.'); return []; }
  const vistos = new Set(['estrella']);
  const defs = [];
  lista.forEach((d, i) => {
    if (!d || typeof d !== 'object') return avisar(`data-objetos[${i}] no es un objeto {...}: se ignora.`);
    const id = String(d.id || '').trim();
    if (!id) return avisar(`data-objetos[${i}] no tiene "id": se ignora.`);
    if (vistos.has(id)) return avisar(`data-objetos: el id "${id}" está repetido (o es "estrella", que es el objeto principal): se ignora.`);
    if (!TIPOS_OBJETO.includes(d.tipo)) return avisar(`data-objetos "${id}": tipo "${d.tipo}" desconocido (vale: ${TIPOS_OBJETO.join(', ')}). Se ignora.`);
    if ((d.tipo === 'glb' || d.tipo === 'logo') && !d.src) return avisar(`data-objetos "${id}": falta "src" (ruta del archivo). Se ignora.`);
    if (d.tipo === 'copia' && !d.de) return avisar(`data-objetos "${id}": falta "de" (id del objeto que copia, p. ej. "estrella"). Se ignora.`);
    vistos.add(id);
    defs.push({ ...d, id });
  });
  defs.forEach((d) => {
    if (d.tipo === 'copia' && d.de !== 'estrella' && !defs.some((o) => o.id === d.de && o.tipo !== 'copia' && !AMBIENTE(o.tipo))) {
      avisar(`data-objetos "${d.id}": copia de "${d.de}", que no existe o no se puede copiar (solo "estrella", "glb" o "logo").`);
      d.invalida = true;
    }
  });
  return defs.filter((d) => !d.invalida);
}

/* ---------- Estado por sección ---------- */
const ESTADO_BASE = {
  rot: [0, 0, 0], pos: [0, 0, 0], escala: 1, opacidad: 1,
  cam: [0, 0, 6], mira: [0, 0, 0], color: null, explota: 0, luz: 1,
};
const estadoExtraBase = (def) => ({
  pos: [0, 0, 0], rot: [0, 0, 0], escala: 1,
  opacidad: def.tipo === 'particulas' ? 1 : 0,   // las partículas se ven desde el principio; el resto aparece cuando una sección lo pide
  color: def.color || null,
});

function leerEstados(secciones, defs = []) {
  const estados = [];
  let anterior = { ...ESTADO_BASE, objetos: Object.fromEntries(defs.map((d) => [d.id, estadoExtraBase(d)])) };
  secciones.forEach((sec, i) => {
    let propio = {};
    const crudo = sec.dataset['3d'];
    if (crudo) {
      try { propio = JSON.parse(crudo); }
      catch (e) { avisar(`data-3d de la sección ${i + 1} no es JSON válido: ${e.message}`); }
    }
    const { objetos: propios = {}, ...resto } = propio;
    const objetos = {};
    for (const d of defs) objetos[d.id] = { ...anterior.objetos[d.id], ...(propios[d.id] || {}), arco: Number(propios[d.id]?.arco) || 0 };
    resto.arco = Number(resto.arco) || 0;
    for (const id of Object.keys(propios)) {
      if (!defs.some((d) => d.id === id)) avisar(`data-3d de la sección ${i + 1}: el objeto "${id}" no está en data-objetos.`);
    }
    const estado = { ...anterior, ...resto, objetos };
    estados.push(estado);
    anterior = estado;
  });
  return estados;
}

/* ---------- Arranque ---------- */
const main = document.querySelector('[data-motor3d]');
if (!main) {
  avisar('No hay ningún elemento con data-motor3d: el motor no arranca.');
} else {
  arrancar(main);
}

function arrancar(main) {
  const cfg = {
    modelo: main.dataset.modelo || '',
    acento: main.dataset.acento || getComputedStyle(document.documentElement).getPropertyValue('--m3d-acento').trim() || '#fac51c',
    fondo: main.dataset.fondo || getComputedStyle(document.documentElement).getPropertyValue('--m3d-fondo').trim() || '#0b0b0f',
    poster: main.dataset.poster || '',
    fotogramas: main.dataset.fotogramas || '',
    fotogramasTotal: parseInt(main.dataset.fotogramasTotal || '0', 10) || 0,
    modoForzado: main.dataset.modo || '',
    sombra: main.dataset.sombra !== 'no',
    // Giro automático en la primera sección: "completo" (vuelta entera) o "vaiven" (oscila ±35°, sin enseñar la parte
    // trasera: para modelos hechos de una sola foto, cuya trasera es inventada)
    giro: main.dataset.giro === 'vaiven' ? 'vaiven' : 'completo',
  };
  if (main.dataset.fondo) document.documentElement.style.setProperty('--m3d-fondo', cfg.fondo);
  if (main.dataset.acento) document.documentElement.style.setProperty('--m3d-acento', cfg.acento);

  const defs = leerDefiniciones(main);
  const secciones = [...main.querySelectorAll('.m3d-seccion')];
  if (!secciones.length) avisar('No hay secciones .m3d-seccion: el objeto se quedará quieto.');
  const estados = leerEstados(secciones.length ? secciones : [main], defs);

  // Canvas fijo detrás del contenido
  let canvas = document.getElementById('escena3d');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'escena3d';
    document.body.prepend(canvas);
  }
  canvas.setAttribute('aria-hidden', 'true');

  // Elegir modo
  const hayFotogramas = !!(cfg.fotogramas && cfg.fotogramasTotal > 0);
  let modo = cfg.modoForzado;
  if (!['3d', 'fotogramas', 'poster'].includes(modo)) {
    if (!hayWebGL2) { avisar('Este navegador no tiene WebGL 2: se usa el modo de respaldo.'); modo = hayFotogramas ? 'fotogramas' : 'poster'; }
    else if (tactil && pocaPotencia && hayFotogramas) modo = 'fotogramas';
    else modo = '3d';
  }
  if (modo === '3d' && !hayWebGL2) {
    avisar('Este navegador no tiene WebGL 2: se usa el modo de respaldo.');
    modo = hayFotogramas ? 'fotogramas' : 'poster';
  }
  if (modo === 'fotogramas' && !hayFotogramas) {
    avisar('Modo fotogramas pedido pero faltan data-fotogramas o data-fotogramas-total: se usa el póster.');
    modo = 'poster';
  }
  if (modo === 'poster' && !cfg.poster) avisar('No hay data-poster: el fondo se queda vacío.');

  // Scroll suave + integración con ScrollTrigger (receta oficial de Lenis)
  let lenis = null;
  if (!reducido) {
    lenis = new Lenis({ lerp: 0.1, smoothWheel: true, syncTouch: false, anchors: true });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.lagSmoothing(0);
  }

  const api = {
    escena: null, camara: null, renderer: null, objeto: null, objetos: {}, timeline: null,
    modo, listo: null, listoTodo: null, lenis,
  };
  window.motor3d = api;

  iniciarExtras(main);

  let resolverListo;
  api.listo = new Promise((res) => { resolverListo = res; });
  api.listoTodo = api.listo;

  if (modo === '3d') {
    iniciar3D({ main, canvas, cfg, secciones, estados, defs, api, lenis, resolverListo });
  } else if (modo === 'fotogramas') {
    iniciarFotogramas({ main, canvas, cfg, api, lenis, resolverListo });
  } else {
    iniciarPoster({ canvas, cfg, api, lenis, resolverListo });
  }
}

/* =====================================================================
   MODO 3D
   ===================================================================== */
function iniciar3D({ main, canvas, cfg, secciones, estados, defs, api, lenis, resolverListo }) {
  let renderer;
  try {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    renderer = new THREE.WebGLRenderer({
      canvas, alpha: true, antialias: dpr <= 1.5, powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(dpr);
  } catch (e) {
    avisar('No se pudo crear el contexto WebGL:', e.message);
    return caerARespaldo({ main, canvas, cfg, api, lenis, resolverListo });
  }
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = cfg.sombra;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const escena = new THREE.Scene();
  const camara = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 100);
  camara.position.set(...estados[0].cam);

  // Iluminación: entorno de estudio (sin HDR) + clave + relleno
  const pmrem = new THREE.PMREMGenerator(renderer);
  escena.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const luzClave = new THREE.DirectionalLight(0xffffff, 2.4);
  luzClave.position.set(3, 5, 4);
  luzClave.castShadow = cfg.sombra;
  luzClave.shadow.mapSize.set(1024, 1024);
  luzClave.shadow.camera.left = luzClave.shadow.camera.bottom = -4;
  luzClave.shadow.camera.right = luzClave.shadow.camera.top = 4;
  luzClave.shadow.camera.near = 0.5; luzClave.shadow.camera.far = 20;
  luzClave.shadow.radius = 4;
  const luzRelleno = new THREE.DirectionalLight(0xffffff, 0.7);
  luzRelleno.position.set(-4, 1.5, -3);
  escena.add(luzClave, luzRelleno);

  // Jerarquía: raiz (ajuste móvil) > pivote (estado de scroll) > flotador (bob/giro/parallax) > objeto estrella
  //            raiz > raizExtras (parallax) > grupo de cada objeto adicional (estado de scroll) > nodo
  const raiz = new THREE.Group();
  const pivote = new THREE.Group();
  const flotador = new THREE.Group();
  const raizExtras = new THREE.Group();
  raiz.add(pivote); pivote.add(flotador); raiz.add(raizExtras); escena.add(raiz);

  // Sombra de contacto: plano que solo recibe sombra
  let sombra = null;
  if (cfg.sombra) {
    sombra = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.ShadowMaterial({ opacity: 0.32 }));
    sombra.rotation.x = -Math.PI / 2;
    sombra.receiveShadow = true;
    raiz.add(sombra);
  }

  const acento = new THREE.Color(cfg.acento);
  let objeto = null;          // el modelo normalizado (o el TorusKnot)
  let piezas = [];            // { malla, base: Vector3, dir: Vector3 } para la vista explosionada
  let matPrincipal = null;    // material que se tiñe con "color"
  let colorOriginal = null;
  let matsEstrella = [];      // { mat, opacidad, transparente } para la opacidad del estrella

  function instalarObjeto(nodo) {
    if (objeto) { flotador.remove(objeto); liberar(objeto); }
    objeto = nodo;
    normalizar(objeto);
    prepararPiezas(objeto);
    elegirMaterialPrincipal(objeto);
    objeto.traverse((n) => { if (n.isMesh) { n.castShadow = cfg.sombra; n.receiveShadow = false; } });
    matsEstrella = [];
    const vistos = new Set();
    objeto.traverse((n) => {
      if (!n.isMesh) return;
      (Array.isArray(n.material) ? n.material : [n.material]).forEach((m) => {
        if (!m || vistos.has(m)) return;
        vistos.add(m);
        matsEstrella.push({ mat: m, opacidad: m.opacity ?? 1, transparente: !!m.transparent });
      });
    });
    flotador.add(objeto);
    api.objeto = objeto;
    api.objetos.estrella = objeto;
  }

  function normalizar(nodo, alto = 2.2) {
    nodo.updateMatrixWorld(true);
    const caja = new THREE.Box3().setFromObject(nodo);
    if (caja.isEmpty()) return;
    const tam = caja.getSize(new THREE.Vector3());
    const centro = caja.getCenter(new THREE.Vector3());
    const mayor = Math.max(tam.x, tam.y, tam.z) || 1;
    const f = alto / mayor;             // escala 1 = ~2,2 unidades de alto
    nodo.position.sub(centro).multiplyScalar(f);
    nodo.scale.multiplyScalar(f);
    nodo.updateMatrixWorld(true);
  }

  function prepararPiezas(nodo) {
    piezas = [];
    const mallas = [];
    nodo.traverse((n) => { if (n.isMesh) mallas.push(n); });
    if (mallas.length < 2) return;   // una sola malla: nada que explosionar
    nodo.updateMatrixWorld(true);
    const centroGlobal = new THREE.Box3().setFromObject(nodo).getCenter(new THREE.Vector3());
    const inversa = new THREE.Matrix4();
    mallas.forEach((malla) => {
      if (!malla.geometry.boundingBox) malla.geometry.computeBoundingBox();
      const c = malla.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(malla.matrixWorld);
      const dirMundo = c.sub(centroGlobal);
      if (dirMundo.length() < 1e-4) return;
      // La dirección y el alcance se pasan al espacio local del padre (donde vive malla.position). El nodo raíz
      // lleva la escala de normalizar(): si el alcance se dejara en unidades de mundo, la explosión dependería
      // de las unidades del archivo (metros, centímetros) y no del valor de "explota".
      inversa.copy(malla.parent.matrixWorld).invert();
      const lineal = new THREE.Matrix3().setFromMatrix4(inversa);
      const dirLocal = dirMundo.clone().applyMatrix3(lineal);
      const factor = dirLocal.length() / dirMundo.length();
      piezas.push({ malla, base: malla.position.clone(), dir: dirLocal.normalize(), alcance: (0.4 + dirMundo.length()) * factor });
    });
  }

  function elegirMaterialPrincipal(nodo) {
    let mejor = null, max = -1;
    nodo.traverse((n) => {
      if (!n.isMesh) return;
      const tri = n.geometry.index ? n.geometry.index.count / 3 : n.geometry.attributes.position?.count / 3 || 0;
      if (tri > max) { max = tri; mejor = n; }
    });
    const mat = mejor ? (Array.isArray(mejor.material) ? mejor.material[0] : mejor.material) : null;
    matPrincipal = mat && mat.color ? mat : null;
    colorOriginal = matPrincipal ? matPrincipal.color.clone() : null;
  }

  function objetoProcedimental() {
    const geo = new THREE.TorusKnotGeometry(0.72, 0.24, 240, 40);
    const mat = new THREE.MeshPhysicalMaterial({
      color: acento, metalness: 0.45, roughness: 0.22,
      clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 1.2,
    });
    return new THREE.Mesh(geo, mat);
  }

  function liberar(nodo) {
    nodo.traverse((n) => {
      if (n.geometry) n.geometry.dispose();
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      mats.forEach((m) => {
        if (!m) return;
        Object.values(m).forEach((v) => { if (v && v.isTexture) v.dispose(); });
        m.dispose();
      });
    });
  }

  // Cargadores compartidos (GLB con Draco y Meshopt)
  const draco = new DRACOLoader();
  draco.setDecoderPath(RUTA_DRACO);
  const cargadorGLB = new GLTFLoader();
  cargadorGLB.setDRACOLoader(draco);
  cargadorGLB.setMeshoptDecoder(MeshoptDecoder);
  const cargarGLB = (ruta) => new Promise((res, rej) => cargadorGLB.load(ruta, (g) => res(g.scene), undefined, (e) => rej(new Error(e?.message || String(e)))));

  // Carga del objeto estrella (con respaldo procedimental)
  const cargarModelo = new Promise((res) => {
    if (!cfg.modelo) {
      avisar('No hay data-modelo: se muestra un objeto de muestra.');
      instalarObjeto(objetoProcedimental());
      return res(false);
    }
    cargarGLB(cfg.modelo).then(
      (nodo) => { instalarObjeto(nodo); res(true); },
      (err) => {
        avisar(`No se pudo cargar el modelo "${cfg.modelo}" (${err.message}). Se muestra un objeto de muestra.`);
        instalarObjeto(objetoProcedimental());
        res(false);
      },
    );
  });

  /* ---------- Objetos adicionales ---------- */
  // Generador determinista: la misma semilla da la misma disposición en cada carga (capturas estables)
  function azar(semilla) {
    let s = (Number(semilla) || 1) >>> 0;
    return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  function texturaPunto() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.75)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  function crearParticulas(def) {
    const n = clamp(parseInt(def.cantidad, 10) || 120, 10, 800);
    const rnd = azar(def.semilla ?? 7);
    const [ancho, alto, prof] = def.extension || [9, 6, 5];
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (rnd() - 0.5) * ancho;
      pos[i * 3 + 1] = (rnd() - 0.5) * alto;
      pos[i * 3 + 2] = (rnd() - 0.5) * prof - 1.2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      size: Number(def.tamano) || 0.09, map: texturaPunto(), color: new THREE.Color(def.color || cfg.acento),
      transparent: true, opacity: 0.85, depthWrite: false, sizeAttenuation: true,
    });
    const puntos = new THREE.Points(geo, mat);
    puntos.userData.ambiente = 'particulas';
    return puntos;
  }

  async function crearFormas(def) {
    const n = clamp(parseInt(def.cantidad, 10) || 6, 1, 60);
    const rnd = azar(def.semilla ?? 3);
    // Con "src", cada forma es una copia de ese GLB (normalizado a "tamano" unidades, 0.5 por defecto)
    let base = null;
    if (def.src) {
      base = await cargarGLB(def.src);
      normalizar(base, Number(def.tamano) || 0.5);
      base.traverse((m) => { if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; } });
    }
    const fabricas = {
      esfera: () => new THREE.SphereGeometry(0.24, 32, 16),
      anillo: () => new THREE.TorusGeometry(0.28, 0.055, 24, 72),
      cubo: () => new THREE.BoxGeometry(0.34, 0.34, 0.34),
      nudo: () => new THREE.TorusKnotGeometry(0.2, 0.065, 140, 20),
    };
    const nombres = Object.keys(fabricas);
    const forma = fabricas[def.forma] ? def.forma : 'mixto';
    const geos = {};
    const grupo = new THREE.Group();
    const radioMin = Number(def.radio) || 1.7;
    for (let i = 0; i < n; i++) {
      let m;
      if (base) {
        m = base.clone(true);   // comparte geometría y materiales: no pesa más
      } else {
        const tipo = forma === 'mixto' ? nombres[i % nombres.length] : forma;
        geos[tipo] ||= fabricas[tipo]();
        const mat = new THREE.MeshPhysicalMaterial({
          color: new THREE.Color(def.color || cfg.acento), metalness: 0.5, roughness: 0.22 + rnd() * 0.2,
          clearcoat: 1, clearcoatRoughness: 0.15, envMapIntensity: 1.1,
        });
        m = new THREE.Mesh(geos[tipo], mat);
      }
      const ang = (i / n) * Math.PI * 2 + rnd() * 0.6;
      const r = radioMin + rnd() * 0.9;
      // Por detrás del plano del objeto (z negativa): flotan alrededor sin atravesarlo
      m.position.set(Math.cos(ang) * r, (rnd() - 0.5) * 2.6, -0.5 - rnd() * 1.4);
      m.rotation.set(rnd() * Math.PI, rnd() * Math.PI, 0);
      m.scale.multiplyScalar(0.6 + rnd() * 0.7);
      m.userData = { baseY: m.position.y, fase: rnd() * Math.PI * 2, vx: (rnd() - 0.5) * 0.6, vy: (rnd() - 0.5) * 0.8 };
      grupo.add(m);
    }
    grupo.userData.ambiente = 'formas';
    return grupo;
  }

  const cargarImagen = (src) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => (img.naturalWidth ? res(img) : rej(new Error('la imagen no tiene tamaño (un SVG necesita width y height)')));
    img.onerror = () => rej(new Error('no se pudo cargar'));
    img.src = src;
  });

  // Placa: una tarjeta fina con el logo pintado sobre el color de fondo de la web.
  // Con "fondo":"transparente" (y un png con transparencia), el logo flota recortado, con un poco de grosor
  async function crearPlaca(def) {
    const img = await cargarImagen(def.src);
    const W = 1024, H = clamp(Math.round((W * img.naturalHeight) / img.naturalWidth), 64, 2048);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const recorte = String(def.fondo || '').toLowerCase() === 'transparente';
    if (recorte) {
      ctx.drawImage(img, 0, 0, W, H);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      const ancho = 2, alto = (2 * H) / W, capas = 5, paso = Number(def.grosor) || 0.05;
      const grupo = new THREE.Group();
      for (let i = 0; i < capas; i++) {
        const frente = i === 0;
        const mat = new THREE.MeshPhysicalMaterial({
          map: tex, transparent: true, alphaTest: 0.08, side: THREE.DoubleSide,
          color: frente ? 0xffffff : new THREE.Color(0xffffff).multiplyScalar(0.35),
          metalness: 0, roughness: 0.85, envMapIntensity: 0.25,
          emissiveMap: frente ? tex : null, emissive: frente ? 0xffffff : 0x000000, emissiveIntensity: frente ? 0.5 : 0,
        });
        const m = new THREE.Mesh(new THREE.PlaneGeometry(ancho, alto), mat);
        m.position.z = -i * paso;
        m.castShadow = false;
        grupo.add(m);
      }
      normalizar(grupo);
      return grupo;
    }
    ctx.fillStyle = def.fondo || cfg.fondo;
    ctx.fillRect(0, 0, W, H);
    const margen = Number(def.margen ?? 0.08);
    ctx.drawImage(img, W * margen, H * margen, W * (1 - 2 * margen), H * (1 - 2 * margen));
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    const base = new THREE.Color(def.fondo || cfg.fondo);
    const canto = new THREE.MeshPhysicalMaterial({ color: base.clone().lerp(new THREE.Color(cfg.acento), 0.35), metalness: 0.3, roughness: 0.4, clearcoat: 0.6 });
    // Frente mate: sin brillo que lave el logo cuando mira de frente a la cámara; el mapa también como emisivo suave
    // para que conserve sus colores bajo el tono cinematográfico
    const frente = new THREE.MeshPhysicalMaterial({
      map: tex, color: 0xffffff, metalness: 0, roughness: 0.85, clearcoat: 0, envMapIntensity: 0.25,
      emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.5,
    });
    const dorso = new THREE.MeshPhysicalMaterial({ color: base, metalness: 0.2, roughness: 0.5 });
    const ancho = 2, alto = (2 * H) / W, grosor = Number(def.grosor) || 0.08;
    const malla = new THREE.Mesh(new THREE.BoxGeometry(ancho, alto, grosor), [canto, canto, canto, canto, frente, dorso]);
    const grupo = new THREE.Group();
    grupo.add(malla);
    normalizar(grupo);
    return grupo;
  }

  // Logo en volumen: los trazados del SVG extruidos con sus colores (si el SVG lleva <text>, o es png/jpg, se hace una placa)
  async function crearLogo(def) {
    if (/\.svg(\?|#|$)/i.test(def.src)) {
      const r = await fetch(def.src);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const svg = await r.text();
      const tieneTexto = /<text[\s>]/i.test(svg);
      const tieneTrazos = /<(path|rect|circle|ellipse|polygon|polyline)\b/i.test(svg);
      if (tieneTrazos && !tieneTexto) {
        const datos = new SVGLoader().parse(svg);
        const grupo = new THREE.Group();
        const caja = new THREE.Box2();
        const piezasLogo = [];
        for (const trazo of datos.paths) {
          const estilo = trazo.userData?.style || {};
          const relleno = estilo.fill;
          if (!relleno || relleno === 'none') continue;
          const formas = SVGLoader.createShapes(trazo);
          if (!formas.length) continue;
          formas.forEach((f) => f.getPoints().forEach((p) => caja.expandByPoint(p)));
          piezasLogo.push({ formas, relleno, opacidad: Number(estilo.fillOpacity ?? estilo.opacity ?? 1) });
        }
        if (piezasLogo.length) {
          const tam = caja.getSize(new THREE.Vector2());
          const profundidad = Math.max(tam.x, tam.y) * (Number(def.grosor) || 0.12);
          for (const p of piezasLogo) {
            let color;
            try { color = new THREE.Color().setStyle(/^(currentcolor|inherit)$/i.test(p.relleno) ? cfg.acento : p.relleno); }
            catch { color = acento.clone(); }
            const geo = new THREE.ExtrudeGeometry(p.formas, {
              depth: profundidad, bevelEnabled: true, bevelThickness: profundidad * 0.12, bevelSize: profundidad * 0.08, bevelSegments: 2, curveSegments: 14,
            });
            const mat = new THREE.MeshPhysicalMaterial({ color, metalness: 0.35, roughness: 0.32, clearcoat: 0.8, clearcoatRoughness: 0.15, transparent: p.opacidad < 1, opacity: p.opacidad });
            grupo.add(new THREE.Mesh(geo, mat));
          }
          grupo.scale.y = -1;   // el SVG tiene la Y hacia abajo
          const envoltorio = new THREE.Group();
          envoltorio.add(grupo);
          normalizar(envoltorio);
          return envoltorio;
        }
      }
      if (tieneTexto) avisar(`Logo "${def.id}": el SVG lleva texto (<text>), que no se puede extruir. Se muestra como placa.`);
    }
    return crearPlaca(def);
  }

  function clonarNodo(fuente) {
    const copia = fuente.clone(true);
    // Materiales propios (para teñir la copia sin tocar el original); la geometría se comparte
    copia.traverse((n) => {
      if (!n.isMesh) return;
      n.material = Array.isArray(n.material) ? n.material.map((m) => m.clone()) : n.material.clone();
      n.castShadow = cfg.sombra; n.receiveShadow = false;
    });
    // Si el original está en vista explosionada en este momento, la copia vuelve a la posición base
    if (fuente === objeto && piezas.length) {
      const nodosFuente = [];
      fuente.traverse((n) => nodosFuente.push(n));
      let k = 0;
      copia.traverse((n) => { const p = piezas.find((pz) => pz.malla === nodosFuente[k++]); if (p) n.position.copy(p.base); });
    }
    return copia;
  }

  // Cada objeto adicional: { def, grupo, nodo, mats: [{ mat, color, opacidad, transparente }], fase, listo }
  const extras = defs.map((def, i) => {
    const grupo = new THREE.Group();
    grupo.visible = false;
    raizExtras.add(grupo);
    return { def, i, grupo, nodo: null, mats: [], fase: (i + 1) * 1.7, listo: null };
  });
  const porId = Object.fromEntries(extras.map((e) => [e.def.id, e]));

  function instalarExtra(extra, nodo) {
    extra.nodo = nodo;
    extra.mats = [];
    const vistos = new Set();
    nodo.traverse((n) => {
      if (!n.isMesh && !n.isPoints) return;
      if (n.isMesh) { n.castShadow = cfg.sombra && !AMBIENTE(extra.def.tipo); n.receiveShadow = false; }
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      mats.forEach((m) => {
        if (!m || vistos.has(m)) return;
        vistos.add(m);
        extra.mats.push({ mat: m, color: m.color ? m.color.clone() : null, opacidad: m.opacity ?? 1, transparente: !!m.transparent });
      });
    });
    extra.grupo.add(nodo);
    api.objetos[extra.def.id] = nodo;
    if (extra.def.estela) {
      const e = typeof extra.def.estela === 'object' ? extra.def.estela : {};
      const mat = e.guiones === false
        ? new THREE.LineBasicMaterial({ color: new THREE.Color(e.color || cfg.acento), transparent: true, opacity: Number(e.opacidad) || 0.8 })
        : new THREE.LineDashedMaterial({ color: new THREE.Color(e.color || cfg.acento), dashSize: Number(e.guion) || 0.14, gapSize: Number(e.hueco) || 0.1, transparent: true, opacity: Number(e.opacidad) || 0.8 });
      const linea = new THREE.Line(new THREE.BufferGeometry(), mat);
      linea.frustumCulled = false;
      linea.visible = false;
      raizExtras.add(linea);
      extra.estela = { linea, puntos: [] };
    }
  }

  // La estela crece con el objeto y se recorta al volver atrás con el scroll
  function actualizarEstela(ex, progreso, visible) {
    const es = ex.estela;
    const g = ex.grupo;
    let cambio = false;
    while (es.puntos.length && es.puntos[es.puntos.length - 1].p > progreso + 1e-6) { es.puntos.pop(); cambio = true; }
    if (!visible) { if (es.puntos.length) { es.puntos = []; cambio = true; } }
    else {
      const ultimo = es.puntos[es.puntos.length - 1];
      if (!ultimo || ultimo.v.distanceTo(g.position) > 0.05) { es.puntos.push({ p: progreso, v: g.position.clone() }); cambio = true; }
    }
    if (!cambio) return;
    es.linea.visible = es.puntos.length > 1;
    if (es.linea.visible) {
      es.linea.geometry.dispose();
      es.linea.geometry = new THREE.BufferGeometry().setFromPoints(es.puntos.map((q) => q.v));
      es.linea.computeLineDistances();
    }
  }

  function cargarExtra(extra) {
    const { def } = extra;
    if (extra.listo) return extra.listo;
    extra.listo = (async () => {
      try {
        let nodo;
        if (def.tipo === 'glb') { nodo = await cargarGLB(def.src); normalizar(nodo); }
        else if (def.tipo === 'logo') nodo = await crearLogo(def);
        else if (def.tipo === 'particulas') nodo = crearParticulas(def);
        else if (def.tipo === 'formas') nodo = await crearFormas(def);
        else if (def.tipo === 'copia') {
          let fuente;
          if (def.de === 'estrella') { await cargarModelo; fuente = objeto; }
          else { await cargarExtra(porId[def.de]); fuente = porId[def.de].nodo; }
          if (!fuente) throw new Error(`el objeto "${def.de}" no se pudo cargar`);
          nodo = clonarNodo(fuente);
        }
        instalarExtra(extra, nodo);
        return true;
      } catch (e) {
        avisar(`No se pudo crear el objeto "${def.id}" (${def.tipo}${def.src ? `, ${def.src}` : ''}): ${e.message}. Se omite.`);
        return false;
      }
    })();
    return extra.listo;
  }
  const cargarExtras = Promise.all(extras.map(cargarExtra));

  /* ---------- Estado animable ---------- */
  const estado = {
    px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, escala: 1,
    cx: 0, cy: 0, cz: 6, mx: 0, my: 0, mz: 0,
    explota: 0, luz: 1, tinte: 0, color: new THREE.Color(cfg.acento),
    t: 1, arco: 0, op: 1,
  };
  const coloresExtras = extras.map(() => new THREE.Color(cfg.acento));
  const k = (i, campo) => `e${i}_${campo}`;
  const aPlano = (e) => {
    const plano = {
      px: e.pos[0], py: e.pos[1], pz: e.pos[2],
      rx: e.rot[0] * RAD, ry: e.rot[1] * RAD, rz: e.rot[2] * RAD,
      escala: e.escala,
      cx: e.cam[0], cy: e.cam[1], cz: e.cam[2],
      mx: e.mira[0], my: e.mira[1], mz: e.mira[2],
      explota: e.explota, luz: e.luz, tinte: e.color ? 1 : 0,
      op: clamp(Number(e.opacidad ?? 1), 0, 1),
    };
    extras.forEach((ex, i) => {
      const o = e.objetos[ex.def.id];
      plano[k(i, 'px')] = o.pos[0]; plano[k(i, 'py')] = o.pos[1]; plano[k(i, 'pz')] = o.pos[2];
      plano[k(i, 'rx')] = o.rot[0] * RAD; plano[k(i, 'ry')] = o.rot[1] * RAD; plano[k(i, 'rz')] = o.rot[2] * RAD;
      plano[k(i, 'es')] = o.escala; plano[k(i, 'op')] = clamp(Number(o.opacidad), 0, 1); plano[k(i, 'ti')] = o.color ? 1 : 0;
    });
    return plano;
  };
  // Arco: la posición sube "arco" unidades a mitad de la transición y vuelve a bajar (trayectorias curvas: un avión,
  // un salto). t va de 0 a 1 en cada transición; arco es el valor de la sección de destino
  const tweenArco = (tl, ini, dur, i) => {
    tl.fromTo(estado, { t: 0, arco: estados[i].arco }, { t: 1, arco: estados[i].arco, duration: dur, ease: 'none' }, ini);
    extras.forEach((ex, j) => {
      const a = estados[i].objetos[ex.def.id].arco;
      tl.fromTo(estado, { [k(j, 't')]: 0, [k(j, 'arco')]: a }, { [k(j, 't')]: 1, [k(j, 'arco')]: a, duration: dur, ease: 'none' }, ini);
    });
  };
  extras.forEach((ex, j) => { estado[k(j, 't')] = 1; estado[k(j, 'arco')] = 0; });
  const colorDe = (e, i) => {
    // Color del estado i; si no tiene, hereda el último definido (o el acento)
    for (let j = i; j >= 0; j--) if (estados[j].color) return new THREE.Color(estados[j].color);
    return new THREE.Color(cfg.acento);
  };
  const colorExtraDe = (ex, i) => {
    for (let j = i; j >= 0; j--) { const c = estados[j].objetos[ex.def.id].color; if (c) return new THREE.Color(c); }
    return new THREE.Color(cfg.acento);
  };

  let timeline = null;
  let puntos = [];   // progreso (0..1) en el que se alcanza cada sección

  function construirTimeline() {
    if (timeline) { timeline.scrollTrigger?.kill(); timeline.kill(); }
    // El recorrido es el documento entero (con el pie): la última sección llega a su estado al final del todo,
    // que es donde se queda el usuario (si acabara en el <main>, el pie empujaría el texto sobre el objeto)
    const desplazable = document.documentElement.scrollHeight - innerHeight;
    puntos = secciones.map((s) => desplazable > 0
      ? clamp((s.getBoundingClientRect().top + scrollY) / desplazable, 0, 1) : 0);
    if (puntos.length > 1) puntos[puntos.length - 1] = 1;

    Object.assign(estado, aPlano(estados[0]));
    estado.color.copy(colorDe(estados[0], 0));
    extras.forEach((ex, i) => coloresExtras[i].copy(colorExtraDe(ex, 0)));

    timeline = gsap.timeline({
      defaults: { ease: 'power1.inOut', lazy: false, immediateRender: false },
      scrollTrigger: { trigger: document.documentElement, start: 'top top', end: 'bottom bottom', scrub: reducido ? true : 1 },
    });
    for (let i = 1; i < estados.length; i++) {
      const ini = puntos[i - 1];
      const dur = Math.max(puntos[i] - ini, 0.0001);
      timeline.fromTo(estado, aPlano(estados[i - 1]), { ...aPlano(estados[i]), duration: dur }, ini);
      tweenArco(timeline, ini, dur, i);
      const c0 = colorDe(estados[i - 1], i - 1), c1 = colorDe(estados[i], i);
      timeline.fromTo(estado.color, { r: c0.r, g: c0.g, b: c0.b }, { r: c1.r, g: c1.g, b: c1.b, duration: dur }, ini);
      extras.forEach((ex, j) => {
        const a = colorExtraDe(ex, i - 1), b = colorExtraDe(ex, i);
        timeline.fromTo(coloresExtras[j], { r: a.r, g: a.g, b: a.b }, { r: b.r, g: b.g, b: b.b, duration: dur }, ini);
      });
    }
    const fin = puntos[puntos.length - 1] || 0;
    if (fin < 1) timeline.to({}, { duration: 1 - fin }, fin);   // el scroll completo = la timeline completa
    api.timeline = timeline;
  }

  /* ---------- Interacción continua ---------- */
  const raton = { x: 0, y: 0, ox: 0, oy: 0 };
  if (!reducido && !tactil) {
    addEventListener('pointermove', (e) => {
      raton.x = (e.clientX / innerWidth - 0.5) * 2;
      raton.y = (e.clientY / innerHeight - 0.5) * 2;
    }, { passive: true });
  }
  let giro = 0;
  const reloj = new THREE.Timer();

  function render(tiempo) {
    if (document.hidden) return;
    reloj.update();
    const dt = Math.min(reloj.getDelta(), 0.1);
    const t = tiempo;
    const esMovil = movil();
    const progreso = timeline ? timeline.progress() : 0;

    // En móvil el objeto vive en la mitad superior: centro al 30 % de la altura (el 20 % por encima del centro de la
    // pantalla) y entre el 26 y el 32 % de alto, por debajo de la cabecera fija y por encima del texto, que empieza al
    // 50 %. Calculado desde la distancia de la cámara para que valga con cualquier "cam" y cualquier tamaño de pantalla
    const arcoY = estado.arco * Math.sin(Math.PI * clamp(estado.t, 0, 1));
    let escalaMovil = 1;
    if (esMovil) {
      const dist = Math.max(estado.cz - estado.pz, 0.5);
      const pxPorUnidad = innerHeight / (2 * dist * Math.tan(camara.fov * RAD / 2));
      // Altura del objeto en pantalla acotada al 26-32 % (conserva la variación entre secciones sin taparlo todo)
      const altoNatural = 2.2 * Math.max(estado.escala, 0.05) * 0.62 * pxPorUnidad;
      const alto = clamp(altoNatural, 0.26 * innerHeight, 0.32 * innerHeight);
      escalaMovil = alto / (2.2 * Math.max(estado.escala, 0.05) * pxPorUnidad);
      raiz.position.y = (0.20 * innerHeight) / pxPorUnidad;
      pivote.position.set(estado.px * 0.25, (estado.py + arcoY) * 0.2, estado.pz);
      pivote.scale.setScalar(estado.escala * escalaMovil);
    } else {
      raiz.position.y = 0;
      pivote.position.set(estado.px, estado.py + arcoY, estado.pz);
      pivote.scale.setScalar(estado.escala);
    }
    pivote.rotation.set(estado.rx, estado.ry, estado.rz);

    // Giro automático solo en la primera sección; después vuelve suavemente a 0
    const primera = puntos[1] || 1;
    const enPrimera = timeline ? 1 - clamp(progreso / primera, 0, 1) : 1;
    if (cfg.giro === 'vaiven') {
      giro = reducido ? 0 : Math.sin(t * 0.45) * 0.6 * enPrimera;   // oscila ±35° y se apaga al salir del hero
    } else if (!reducido && enPrimera > 0.01) giro += dt * 0.35 * enPrimera;
    else {
      giro = ((giro + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      giro += (0 - giro) * 0.06;
    }
    // Flotación + parallax con el ratón
    raton.ox += (raton.x - raton.ox) * 0.05;
    raton.oy += (raton.y - raton.oy) * 0.05;
    flotador.position.y = reducido ? 0 : Math.sin(t * 1.1) * 0.06;
    flotador.rotation.set(reducido ? 0 : raton.oy * 0.12 + Math.sin(t * 0.7) * 0.02, giro + (reducido ? 0 : raton.ox * 0.18), 0);
    raizExtras.rotation.set(reducido ? 0 : raton.oy * 0.06, reducido ? 0 : raton.ox * 0.09, 0);

    camara.position.set(estado.cx, estado.cy, estado.cz);
    camara.lookAt(estado.mx, estado.my, estado.mz);
    luzClave.intensity = 2.4 * estado.luz;

    // Vista explosionada
    if (piezas.length) {
      piezas.forEach((p) => p.malla.position.copy(p.base).addScaledVector(p.dir, estado.explota * p.alcance));
    }
    // Tinte del material principal
    if (matPrincipal) matPrincipal.color.copy(colorOriginal).lerp(estado.color, estado.tinte);
    // Opacidad del estrella (0 = oculto; al aparecer también crece un poco)
    const opEstrella = clamp(estado.op, 0, 1);
    pivote.visible = opEstrella > 0.004;
    if (pivote.visible) {
      pivote.scale.multiplyScalar(0.7 + 0.3 * opEstrella);
      matsEstrella.forEach((m) => { m.mat.opacity = m.opacidad * opEstrella; m.mat.transparent = opEstrella < 0.995 ? true : m.transparente; });
    }

    // Objetos adicionales
    extras.forEach((ex, i) => {
      const g = ex.grupo;
      const op = clamp(estado[k(i, 'op')], 0, 1);
      g.visible = !!ex.nodo && op > 0.004;
      if (ex.estela && !g.visible) actualizarEstela(ex, progreso, false);
      if (!g.visible) return;
      const px = estado[k(i, 'px')], pz = estado[k(i, 'pz')];
      const py = estado[k(i, 'py')] + estado[k(i, 'arco')] * Math.sin(Math.PI * clamp(estado[k(i, 't')], 0, 1));
      g.position.set(esMovil ? px * 0.25 : px, esMovil ? py * 0.2 : py, pz);
      g.rotation.set(estado[k(i, 'rx')], estado[k(i, 'ry')], estado[k(i, 'rz')]);
      if (ex.estela) actualizarEstela(ex, progreso, op > 0.5);
      // Al aparecer crece (de 0,6 a 1): el fundido solo no se nota en un objeto sólido
      g.scale.setScalar(estado[k(i, 'es')] * (AMBIENTE(ex.def.tipo) ? 1 : 0.6 + 0.4 * op) * escalaMovil);
      const tinte = estado[k(i, 'ti')];
      ex.mats.forEach((m) => {
        if (m.color && m.mat.color) m.mat.color.copy(m.color).lerp(coloresExtras[i], tinte);
        m.mat.opacity = m.opacidad * op;
        m.mat.transparent = op < 0.995 ? true : m.transparente;
      });
      // Vida propia: flotación suave; las partículas giran despacio y con el scroll; las formas giran cada una a su ritmo
      const n = ex.nodo;
      if (reducido) return;
      const amb = n.userData.ambiente;
      if (amb === 'particulas') {
        n.rotation.y = t * 0.025 + progreso * 0.9;
        n.position.y = Math.sin(t * 0.4 + ex.fase) * 0.1;
      } else if (amb === 'formas') {
        n.children.forEach((m) => {
          m.rotation.x += dt * m.userData.vx; m.rotation.y += dt * m.userData.vy;
          m.position.y = m.userData.baseY + Math.sin(t * 0.8 + m.userData.fase) * 0.09;
        });
      } else {
        n.position.y = Math.sin(t * 0.9 + ex.fase) * 0.05;
        n.rotation.z = Math.sin(t * 0.5 + ex.fase) * 0.015;
      }
    });

    if (sombra) {
      sombra.position.set(pivote.position.x, pivote.position.y - 1.25 * pivote.scale.y, pivote.position.z);
      sombra.material.opacity = 0.32 * clamp(estado.luz, 0, 1) * opEstrella;
    }
    renderer.render(escena, camara);
  }

  function redimensionar() {
    camara.aspect = innerWidth / innerHeight;
    camara.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  }
  addEventListener('resize', redimensionar);
  ScrollTrigger.addEventListener('refreshInit', construirTimeline);

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    avisar('Se perdió el contexto WebGL: se pasa al modo de respaldo.');
    gsap.ticker.remove(tick);
    caerARespaldo({ main, canvas, cfg, api, lenis, resolverListo: () => {} , reemplazarCanvas: true });
  });

  const tick = (time) => {
    if (lenis) lenis.raf(time * 1000);
    render(time);
  };

  Object.assign(api, { escena, camara, renderer });
  construirTimeline();
  gsap.ticker.add(tick);

  api.listoTodo = Promise.all([cargarModelo, cargarExtras]).then(() => api);
  cargarModelo.then(() => {
    ScrollTrigger.refresh();
    resolverListo(api);
  });
}

/* Cuando el 3D falla en caliente: se sustituye el canvas y se arranca el respaldo */
function caerARespaldo({ main, canvas, cfg, api, lenis, resolverListo, reemplazarCanvas = false }) {
  let lienzo = canvas;
  if (reemplazarCanvas) {
    lienzo = document.createElement('canvas');
    lienzo.id = 'escena3d';
    lienzo.setAttribute('aria-hidden', 'true');
    canvas.replaceWith(lienzo);
  }
  api.renderer = null; api.escena = null; api.camara = null; api.objeto = null; api.objetos = {}; api.timeline = null;
  if (cfg.fotogramas && cfg.fotogramasTotal > 0) {
    api.modo = 'fotogramas';
    iniciarFotogramas({ main, canvas: lienzo, cfg, api, lenis, resolverListo });
  } else {
    api.modo = 'poster';
    iniciarPoster({ canvas: lienzo, cfg, api, lenis, resolverListo });
  }
}

/* =====================================================================
   MODO FOTOGRAMAS (secuencia estilo Apple sobre un canvas 2D)
   ===================================================================== */
function iniciarFotogramas({ main, canvas, cfg, api, lenis, resolverListo }) {
  const ctx = canvas.getContext('2d');
  const total = cfg.fotogramasTotal;
  const base = cfg.fotogramas.endsWith('/') ? cfg.fotogramas : cfg.fotogramas + '/';
  const imagenes = new Array(total).fill(null);
  let progreso = 0, suave = 0, indicePintado = -1;

  const ruta = (i) => `${base}${String(i + 1).padStart(4, '0')}.webp`;

  function cargar(i) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => { imagenes[i] = img; res(true); };
      img.onerror = () => { if (i === 0) avisar(`No se encontró el primer fotograma: ${ruta(0)}`); res(false); };
      img.src = ruta(i);
    });
  }
  // Precarga progresiva: primero el 1, luego el resto en tandas de 4
  (async () => {
    await cargar(0);
    pintar(true);
    resolverListo(api);
    for (let i = 1; i < total; i += 4) {
      await Promise.all([i, i + 1, i + 2, i + 3].filter((k) => k < total).map(cargar));
      pintar(true);
    }
  })();

  function ajustar() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    pintar(true);
  }

  function pintar(forzar = false) {
    const idx = Math.min(total - 1, Math.floor(suave * total));
    // Si ese fotograma aún no está, se usa el último cargado anterior
    let k = idx;
    while (k > 0 && !imagenes[k]) k--;
    const img = imagenes[k];
    if (!img) return;
    if (!forzar && k === indicePintado) return;
    indicePintado = k;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const esc = Math.min(W / img.width, H / img.height);
    const w = img.width * esc, h = img.height * esc;
    const dy = movil() ? (H * 0.45 - h) / 2 : (H - h) / 2;
    ctx.drawImage(img, (W - w) / 2, Math.max(0, dy), w, h);
  }

  ScrollTrigger.create({
    trigger: document.documentElement, start: 'top top', end: 'bottom bottom',
    onUpdate: (self) => { progreso = self.progress; },
  });
  gsap.ticker.add((time) => {
    if (lenis) lenis.raf(time * 1000);
    suave += (progreso - suave) * (reducido ? 1 : 0.12);
    pintar();
  });
  addEventListener('resize', ajustar);
  ajustar();
}

/* =====================================================================
   MODO PÓSTER (imagen fija)
   ===================================================================== */
function iniciarPoster({ canvas, cfg, api, lenis, resolverListo }) {
  if (lenis) gsap.ticker.add((time) => lenis.raf(time * 1000));
  if (!cfg.poster) { resolverListo(api); return; }
  const ctx = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => { pintar(); resolverListo(api); };
  img.onerror = () => { avisar(`No se pudo cargar el póster: ${cfg.poster}`); resolverListo(api); };
  img.src = cfg.poster;

  // El póster ocupa el sitio del objeto en el hero (arriba, centrado, ~42 % de alto) y se atenúa al pasar la
  // primera pantalla para no pelearse con el texto de las demás secciones
  function pintar() {
    if (!img.complete || !img.width) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    const W = canvas.width, H = canvas.height;
    const esc = Math.min((W * 0.8) / img.width, (H * 0.42) / img.height);
    const w = img.width * esc, h = img.height * esc;
    const dy = H * 0.08;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = 1 - 0.82 * clamp(scrollY / innerHeight, 0, 1);
    ctx.drawImage(img, (W - w) / 2, dy, w, h);
    ctx.globalAlpha = 1;
  }
  addEventListener('resize', pintar);
  addEventListener('scroll', () => requestAnimationFrame(pintar), { passive: true });
}

/* =====================================================================
   EXTRAS DE TEXTO (portados del motion-kit, prefijo m3d-)
   ===================================================================== */
function iniciarExtras(main) {
  const raizCSS = document.documentElement.style;

  // Cortina de intro con el logo: se retira del DOM al terminar (o al instante si hay movimiento reducido)
  const intro = document.querySelector('.m3d-intro');
  if (intro) {
    const quitar = () => { if (intro.isConnected) { intro.remove(); ScrollTrigger.refresh(); } };
    if (reducido || captura) quitar();
    else {
      intro.addEventListener('animationend', (e) => { if (e.target === intro) quitar(); });
      setTimeout(quitar, 3800);
    }
  } else {
    raizCSS.setProperty('--m3d-split-base', '0.1s');
  }
  if (captura) raizCSS.setProperty('--m3d-split-base', '0s');

  // Barra de progreso de scroll
  if (!reducido) {
    const barra = document.createElement('div');
    barra.className = 'm3d-progreso';
    document.body.appendChild(barra);
    ScrollTrigger.create({
      trigger: document.documentElement, start: 'top top', end: 'bottom bottom',
      onUpdate: (self) => { barra.style.transform = `scaleX(${self.progress})`; },
    });
  }

  // Titular palabra a palabra
  document.querySelectorAll('.m3d-split').forEach((el) => {
    const palabras = el.textContent.trim().split(/\s+/);
    el.textContent = '';
    palabras.forEach((p, i) => {
      const caja = document.createElement('span');
      caja.className = 'm3d-p';
      const interior = document.createElement('span');
      interior.textContent = p;
      interior.style.setProperty('--m3d-i', i);
      caja.appendChild(interior);
      el.appendChild(caja);
      el.appendChild(document.createTextNode(' '));
    });
  });

  // Aparición al entrar en pantalla
  const io = new IntersectionObserver((entradas) => {
    entradas.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('m3d-visible'); io.unobserve(e.target); }
    });
  }, { threshold: 0.15 });
  document.querySelectorAll('.m3d-reveal').forEach((el) => { if (captura) el.classList.add('m3d-visible'); else io.observe(el); });

  // Contadores: <span class="m3d-contador" data-valor="1200" data-sufijo="+" data-decimales="0">
  // data-valor admite "1500", "1.500" o "12.000" (miles a la española), "1,500" (miles a la inglesa) y "4,8" / "4.8"
  const normalizarNumero = (s) => {
    s = String(s ?? '0').trim();
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return s.replace(/\./g, '').replace(',', '.');
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return s.replace(/,/g, '');
    return s.replace(',', '.');
  };
  const suavizar = (t) => 1 - Math.pow(1 - t, 3);
  const contar = (el) => {
    const numero = normalizarNumero(el.dataset.valor);
    const objetivo = parseFloat(numero) || 0;
    const sufijo = el.dataset.sufijo || '';
    const decimales = el.dataset.decimales != null ? parseInt(el.dataset.decimales, 10)
      : ((numero.match(/\.(\d+)$/) || [])[1] || '').length;
    const formato = (n) => n.toLocaleString('es-ES', { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
    if (reducido || captura) { el.textContent = formato(objetivo) + sufijo; return; }
    let t0 = null;
    const paso = (ts) => {
      if (!t0) t0 = ts;
      const p = Math.min((ts - t0) / 1400, 1);
      el.textContent = formato(objetivo * suavizar(p)) + sufijo;
      if (p < 1) requestAnimationFrame(paso);
    };
    requestAnimationFrame(paso);
  };
  const ioContador = new IntersectionObserver((entradas) => {
    entradas.forEach((e) => {
      if (!e.isIntersecting) return;
      ioContador.unobserve(e.target);
      contar(e.target);
    });
  }, { threshold: 0.6 });
  // En modo captura el valor final se fija ya (fuera de pantalla el observador no dispara)
  document.querySelectorAll('.m3d-contador').forEach((el) => { if (captura) contar(el); else ioContador.observe(el); });

  // Tarjetas con inclinación al pasar el ratón
  if (!reducido && !tactil) {
    document.querySelectorAll('.m3d-tarjeta').forEach((tarjeta) => {
      tarjeta.addEventListener('mousemove', (ev) => {
        const r = tarjeta.getBoundingClientRect();
        const x = (ev.clientX - r.left) / r.width - 0.5;
        const y = (ev.clientY - r.top) / r.height - 0.5;
        tarjeta.style.transform = `translateY(-6px) rotateX(${-y * 6}deg) rotateY(${x * 6}deg)`;
      });
      tarjeta.addEventListener('mouseleave', () => { tarjeta.style.transform = ''; });
    });
  }

  // Cabecera: se compacta al hacer scroll
  const cabecera = document.querySelector('.m3d-cabecera');
  if (cabecera) {
    ScrollTrigger.create({
      start: 40, end: 'max',
      onToggle: (self) => cabecera.classList.toggle('m3d-cabecera--compacta', self.isActive),
    });
  }

  // Si el usuario navega a un ancla sin Lenis (movimiento reducido), que el scroll no salte brusco
  if (reducido) document.documentElement.style.scrollBehavior = 'auto';
  main.classList.add('m3d-activo');
}
