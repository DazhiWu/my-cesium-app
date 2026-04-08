import * as Cesium from 'cesium';
import "cesium/Build/Cesium/Widgets/widgets.css";

Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI0MjNiNjNkYS0yODkxLTRiYTQtOTIyZC03N2E2ZThlNjQ4ZWMiLCJpZCI6MTU5MDY2LCJpYXQiOjE3NTgwODg1NDl9.LGDvn1FV-RgAXvDpYd00ryW2MW05tZosbI-ax4d7yds';

const MATERIAL_COLOR_MAP = {
  'PE管': Cesium.Color.ORANGE,
  '球墨铸铁管': Cesium.Color.DARKSLATEGRAY,
  '灰口铸铁管': Cesium.Color.SLATEGRAY
};

const DEFAULT_COLOR = Cesium.Color.LIGHTGRAY;

let isARMode = false;
let viewer = null;
let mapPickerViewer = null;
let videoStream = null;
let orientationHandler = null;
let cameraHeight = 1.7;
let currentDataset = '洞头区管网';
let datasetEntitiesMap = {};
let allEntities = [];
let originalCameraPosition = null;
let originalCameraOrientation = null;
let originalBasemapOpacity = 1;
let gyroscopeAvailable = false;
let manualMode = false;
let calibrationHeadingOffset = 0;
let calibrationHeightOffset = 0;
let calibrationLatitude = 0;
let calibrationLongitude = 0;
let originalCalibrationLatitude = 0;
let originalCalibrationLongitude = 0;
let mapPickerSelectedLatitude = 0;
let mapPickerSelectedLongitude = 0;
let mapPickerMarker = null;
let videoSource = 'camera';
let videoFileUrl = null;
let hasSeenGuide = false;
let animationFrameId = null;
let geolocationWatchId = null;
let currentLocation = null;

function computeCircle(radius) {
  const positions = [];
  for (let i = 0; i < 360; i += 30) {
    const radians = Cesium.Math.toRadians(i);
    positions.push(new Cesium.Cartesian2(radius * Math.cos(radians), radius * Math.sin(radians)));
  }
  return positions;
}

function getCoordKey(coord) {
  return `${coord[0].toFixed(8)},${coord[1].toFixed(8)}`;
}

function mergeSegments(segments) {
  const mergedGroups = [];
  const usedSegments = new Set();
  const startPointMap = new Map();
  const endPointMap = new Map();

  segments.forEach((segment, index) => {
    const startKey = getCoordKey(segment.startCoord);
    const endKey = getCoordKey(segment.endCoord);
    
    if (!startPointMap.has(startKey)) startPointMap.set(startKey, []);
    startPointMap.get(startKey).push(index);
    
    if (!endPointMap.has(endKey)) endPointMap.set(endKey, []);
    endPointMap.get(endKey).push(index);
  });

  for (let i = 0; i < segments.length; i++) {
    if (usedSegments.has(i)) continue;

    const currentSegment = segments[i];
    const group = [currentSegment];
    usedSegments.add(i);

    let currentStartKey = getCoordKey(currentSegment.startCoord);
    let currentEndKey = getCoordKey(currentSegment.endCoord);
    let extended = true;

    while (extended) {
      extended = false;

      const forwardSegments = startPointMap.get(currentEndKey) || [];
      for (const segIndex of forwardSegments) {
        if (usedSegments.has(segIndex)) continue;
        const nextSeg = segments[segIndex];
        if (nextSeg.gj === currentSegment.gj && nextSeg.cz === currentSegment.cz) {
          group.push(nextSeg);
          usedSegments.add(segIndex);
          currentEndKey = getCoordKey(nextSeg.endCoord);
          extended = true;
          break;
        }
      }

      if (extended) continue;

      const backwardSegments = endPointMap.get(currentStartKey) || [];
      for (const segIndex of backwardSegments) {
        if (usedSegments.has(segIndex)) continue;
        const prevSeg = segments[segIndex];
        if (prevSeg.gj === currentSegment.gj && prevSeg.cz === currentSegment.cz) {
          group.unshift(prevSeg);
          usedSegments.add(segIndex);
          currentStartKey = getCoordKey(prevSeg.startCoord);
          extended = true;
          break;
        }
      }
    }

    mergedGroups.push(group);
  }

  return mergedGroups;
}

function getColorForMaterial(materialType) {
  return MATERIAL_COLOR_MAP[materialType] || DEFAULT_COLOR;
}

async function parseGeoJSON(text) {
  try {
    const data = JSON.parse(text);
    if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
      return data.features;
    } else if (data.type === 'Feature') {
      return [data];
    }
  } catch (e) {
  }
  return null;
}

async function parseJSONLines(text) {
  const lines = text.trim().split('\n');
  const features = [];
  let currentLine = '';
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    
    currentLine += trimmedLine;
    
    try {
      const feature = JSON.parse(currentLine);
      if (feature.type === 'Feature') {
        features.push(feature);
        currentLine = '';
      }
    } catch (e) {
    }
  }
  
  if (currentLine) {
    try {
      const feature = JSON.parse(currentLine);
      if (feature.type === 'Feature') {
        features.push(feature);
      }
    } catch (e) {
      console.warn('JSON Lines 最后一行解析失败:', e);
    }
  }
  
  return features.length > 0 ? features : null;
}

async function loadPipeData(url, timeout = 30000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    console.log(`正在加载数据: ${url}`);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const text = await response.text();
    
    let features = await parseGeoJSON(text);
    if (!features) {
      features = await parseJSONLines(text);
    }
    
    if (!features) {
      throw new Error('无法解析数据格式');
    }

    const segments = [];
    for (const feature of features) {
      try {
        const coordinates = feature.geometry?.coordinates;
        const properties = feature.properties || {};
        
        if (!coordinates || coordinates.length < 2) continue;

        let qdgdgc = properties.qdgdgc;
        let zdgdgc = properties.zdgdgc;
        
        qdgdgc = (qdgdgc !== null && qdgdgc !== undefined) ? parseFloat(qdgdgc) : 0;
        zdgdgc = (zdgdgc !== null && zdgdgc !== undefined) ? parseFloat(zdgdgc) : 0;
        
        if (isNaN(qdgdgc)) qdgdgc = 0;
        if (isNaN(zdgdgc)) zdgdgc = 0;

        const gj = properties.gj ? parseFloat(properties.gj) : 100;
        const cz = properties.cz || '';

        segments.push({
          coordinates: coordinates,
          qdgdgc: qdgdgc,
          zdgdgc: zdgdgc,
          gj: gj,
          cz: cz,
          startCoord: coordinates[0],
          endCoord: coordinates[coordinates.length - 1]
        });
      } catch (featureError) {
        console.warn('处理管线数据时出错:', featureError);
      }
    }

    console.log(`数据加载完成: ${url}, 线段数: ${segments.length}`);
    return segments;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`加载数据失败 ${url}:`, error);
    throw error;
  }
}

async function renderSegments(viewer, segments, datasetName) {
  const mergedGroups = mergeSegments(segments);
  const pipeEntities = [];

  console.log(`${datasetName}: 原始线段数 ${segments.length}, 合并后组数 ${mergedGroups.length}`);

  for (const group of mergedGroups) {
    try {
      const firstSegment = group[0];
      const gj = firstSegment.gj;
      const cz = firstSegment.cz;
      const radius = gj / 2000;
      const color = getColorForMaterial(cz);

      const mergedCoordinates = [];
      for (let i = 0; i < group.length; i++) {
        const segment = group[i];
        if (i === 0) {
          mergedCoordinates.push(...segment.coordinates);
        } else {
          mergedCoordinates.push(...segment.coordinates.slice(1));
        }
      }

      const positions = [];
      for (let i = 0; i < mergedCoordinates.length; i++) {
        const coord = mergedCoordinates[i];
        let height = 0;
        
        if (group.length === 1) {
          if (i === 0) {
            height = group[0].qdgdgc;
          } else if (i === mergedCoordinates.length - 1) {
            height = group[0].zdgdgc;
          } else {
            height = (group[0].qdgdgc + group[0].zdgdgc) / 2;
          }
        } else {
          const segmentIndex = Math.min(i, group.length - 1);
          const segment = group[segmentIndex];
          height = (segment.qdgdgc + segment.zdgdgc) / 2;
        }
        
        positions.push(Cesium.Cartesian3.fromDegrees(coord[0], coord[1], height));
      }

      const entity = viewer.entities.add({
        polylineVolume: {
          positions: positions,
          shape: computeCircle(radius),
          material: color.withAlpha(0.8),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2000)
        }
      });

      pipeEntities.push(entity);
    } catch (groupError) {
      console.warn('处理合并管线组时出错:', groupError);
    }
  }

  return pipeEntities;
}

async function loadPipeNetwork(viewer, dataSources) {
  const allEnts = [];
  const datasetEntsMap = {};
  const loadPromises = dataSources.map(async (source) => {
    try {
      const segments = await loadPipeData(source.url);
      const entities = await renderSegments(viewer, segments, source.name);
      return { name: source.name, entities, success: true };
    } catch (error) {
      console.error(`加载数据集失败 ${source.name}:`, error);
      return { name: source.name, entities: [], success: false, error };
    }
  });

  const results = await Promise.all(loadPromises);
  
  for (const result of results) {
    if (result.success) {
      allEnts.push(...result.entities);
      datasetEntsMap[result.name] = result.entities;
      console.log(`数据集加载成功: ${result.name}, 实体数: ${result.entities.length}`);
    } else {
      console.error(`数据集加载失败: ${result.name}`, result.error);
    }
  }

  return { allEntities: allEnts, datasetEntitiesMap: datasetEntsMap };
}

function showStatus(message, type = 'info') {
  const statusBar = document.getElementById('status-bar');
  if (!statusBar) return;
  
  statusBar.textContent = message;
  statusBar.className = '';
  if (type !== 'info') {
    statusBar.classList.add(type);
  }
  statusBar.style.display = 'block';
  
  setTimeout(() => {
    statusBar.style.display = 'none';
  }, 5000);
}

function showLoading(text = '正在加载...') {
  const loadingIndicator = document.getElementById('loading-indicator');
  const loadingText = document.getElementById('loading-text');
  if (loadingIndicator) {
    loadingIndicator.classList.add('active');
  }
  if (loadingText) {
    loadingText.textContent = text;
  }
}

function hideLoading() {
  const loadingIndicator = document.getElementById('loading-indicator');
  if (loadingIndicator) {
    loadingIndicator.classList.remove('active');
  }
}

function showARGuide() {
  const guideModal = document.getElementById('ar-guide-modal');
  if (guideModal) {
    guideModal.classList.add('active');
  }
}

function hideARGuide() {
  const guideModal = document.getElementById('ar-guide-modal');
  if (guideModal) {
    guideModal.classList.remove('active');
  }
  hasSeenGuide = true;
  try {
    localStorage.setItem('arGuideSeen', 'true');
  } catch (e) {
    console.warn('无法保存到localStorage:', e);
  }
}

function checkGuideSeen() {
  try {
    return localStorage.getItem('arGuideSeen') === 'true';
  } catch (e) {
    return hasSeenGuide;
  }
}

function initGuideEvents() {
  document.getElementById('btn-close-guide')?.addEventListener('click', hideARGuide);
  document.getElementById('btn-guide-done')?.addEventListener('click', hideARGuide);
  
  document.getElementById('ar-guide-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'ar-guide-modal') {
      hideARGuide();
    }
  });
}

function initARButtonEvents() {
  const originalEnterAR = enterARMode;
  
  window.enterARModeWithGuide = async function() {
    if (!checkGuideSeen()) {
      showARGuide();
      return;
    }
    await originalEnterAR();
  };
}

async function startCamera() {
  const videoElement = document.getElementById('video-background');
  if (!videoElement) return false;

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('浏览器不支持摄像头API');
    }

    const constraints = {
      video: {
        facingMode: 'environment',
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    };

    videoStream = await navigator.mediaDevices.getUserMedia(constraints);
    videoElement.srcObject = videoStream;
    
    videoElement.onloadedmetadata = () => {
      videoElement.play().catch(e => {
        console.warn('自动播放失败:', e);
      });
    };
    
    videoElement.style.display = 'block';
    videoElement.style.zIndex = '0';
    
    return true;
  } catch (error) {
    console.warn('无法获取摄像头:', error);
    
    let errorMessage = '无法访问摄像头';
    if (error.name === 'NotAllowedError') {
      errorMessage = '摄像头权限被拒绝，请在浏览器设置中允许访问';
    } else if (error.name === 'NotFoundError') {
      errorMessage = '未找到摄像头设备';
    } else if (error.name === 'NotReadableError') {
      errorMessage = '摄像头被其他应用占用';
    } else if (error.name === 'OverconstrainedError') {
      errorMessage = '无法满足摄像头配置要求';
    } else if (error.name === 'AbortError') {
      errorMessage = '摄像头访问被中断';
    } else if (error.name === 'TypeError') {
      errorMessage = '浏览器不支持摄像头API';
    }
    
    throw new Error(errorMessage);
  }
}

function stopCamera() {
  const videoElement = document.getElementById('video-background');
  if (videoElement) {
    videoElement.style.display = 'none';
    videoElement.srcObject = null;
  }
  
  if (videoStream) {
    videoStream.getTracks().forEach(track => track.stop());
    videoStream = null;
  }
}

function setVideoOpacity(opacity) {
  const videoElement = document.getElementById('video-background');
  if (videoElement) {
    videoElement.style.opacity = opacity;
  }
}

function switchVideoSource(source) {
  videoSource = source;
  
  const btnCamera = document.getElementById('btn-source-camera');
  const btnFile = document.getElementById('btn-source-file');
  const fileUploadContainer = document.getElementById('file-upload-container');
  const playbackControl = document.getElementById('video-playback-control');
  
  btnCamera?.classList.toggle('active', source === 'camera');
  btnFile?.classList.toggle('active', source === 'file');
  
  if (source === 'camera') {
    fileUploadContainer.style.display = 'none';
    playbackControl.style.display = 'none';
    if (isARMode) {
      startCamera();
    }
  } else {
    fileUploadContainer.style.display = 'block';
    stopCamera();
    if (videoFileUrl) {
      playbackControl.style.display = 'flex';
      loadVideoFile(videoFileUrl);
    }
  }
}

function loadVideoFile(fileOrUrl) {
  const videoElement = document.getElementById('video-background');
  if (!videoElement) return;
  
  stopCamera();
  
  if (typeof fileOrUrl === 'string') {
    videoElement.src = fileOrUrl;
  } else {
    if (videoFileUrl) {
      URL.revokeObjectURL(videoFileUrl);
    }
    videoFileUrl = URL.createObjectURL(fileOrUrl);
    videoElement.src = videoFileUrl;
  }
  
  videoElement.loop = true;
  videoElement.style.display = 'block';
  videoElement.play().catch(e => {
    console.warn('自动播放失败:', e);
    showStatus('请点击播放按钮开始视频', 'warning');
  });
  
  document.getElementById('video-playback-control').style.display = 'flex';
}

function playVideo() {
  const videoElement = document.getElementById('video-background');
  if (videoElement) {
    videoElement.play().catch(e => console.warn('播放失败:', e));
  }
}

function pauseVideo() {
  const videoElement = document.getElementById('video-background');
  if (videoElement) {
    videoElement.pause();
  }
}

function checkGyroscopeSupport() {
  return new Promise((resolve) => {
    if (!window.DeviceOrientationEvent) {
      gyroscopeAvailable = false;
      resolve(false);
      return;
    }

    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const isHttps = window.location.protocol === 'https:';
      if (!isHttps) {
        showStatus('⚠️ 陀螺仪需要HTTPS连接！请使用ngrok等工具', 'warning');
        gyroscopeAvailable = false;
        resolve(false);
        return;
      }

      DeviceOrientationEvent.requestPermission()
        .then(response => {
          if (response === 'granted') {
            gyroscopeAvailable = true;
            resolve(true);
          } else {
            gyroscopeAvailable = false;
            showStatus('陀螺仪权限被拒绝，请在浏览器设置中允许', 'warning');
            resolve(false);
          }
        })
        .catch((error) => {
          console.warn('陀螺仪权限请求失败:', error);
          gyroscopeAvailable = false;
          showStatus('陀螺仪权限请求失败', 'warning');
          resolve(false);
        });
    } else {
      gyroscopeAvailable = true;
      resolve(true);
    }
  });
}

let lastOrientationData = null;
let orientationUpdateScheduled = false;

function startOrientationTracking() {
  if (!window.DeviceOrientationEvent) {
    manualMode = true;
    showStatus('设备不支持陀螺仪，使用手动模式', 'warning');
    return;
  }

  orientationHandler = (event) => {
    if (!isARMode || manualMode) return;

    const alpha = event.alpha;
    const beta = event.beta;
    const gamma = event.gamma;

    if (alpha !== null && beta !== null && gamma !== null) {
      lastOrientationData = { alpha, beta, gamma };
      if (!orientationUpdateScheduled) {
        orientationUpdateScheduled = true;
        requestAnimationFrame(() => {
          if (lastOrientationData && isARMode && !manualMode) {
            updateCameraFromOrientation(lastOrientationData.alpha, lastOrientationData.beta, lastOrientationData.gamma);
          }
          orientationUpdateScheduled = false;
        });
      }
    }
  };

  window.addEventListener('deviceorientation', orientationHandler);
}

function stopOrientationTracking() {
  if (orientationHandler) {
    window.removeEventListener('deviceorientation', orientationHandler);
    orientationHandler = null;
  }
}

function updateCameraFromOrientation(alpha, beta, gamma) {
  if (!viewer || !isARMode) return;

  const heading = Cesium.Math.toRadians(360 - alpha) + calibrationHeadingOffset;
  const pitch = Cesium.Math.toRadians(beta);

  if (currentLocation) {
    updateCameraPositionFromLocation();
  }

  viewer.camera.setView({
    orientation: {
      heading: heading,
      pitch: pitch,
      roll: 0
    }
  });
}

function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('浏览器不支持地理定位'));
      return;
    }

    const options = {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    };

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          longitude: position.coords.longitude,
          latitude: position.coords.latitude,
          altitude: position.coords.altitude || 0,
          accuracy: position.coords.accuracy
        });
      },
      (error) => {
        reject(error);
      },
      options
    );
  });
}

function startLocationTracking() {
  if (!navigator.geolocation) {
    showStatus('设备不支持地理定位', 'warning');
    return;
  }

  const options = {
    enableHighAccuracy: true,
    timeout: 5000,
    maximumAge: 0
  };

  geolocationWatchId = navigator.geolocation.watchPosition(
    (position) => {
      currentLocation = {
        longitude: position.coords.longitude,
        latitude: position.coords.latitude,
        altitude: position.coords.altitude || 0,
        accuracy: position.coords.accuracy
      };
      updateCameraPositionFromLocation();
      updateGPSDisplay();
    },
    (error) => {
      console.warn('位置跟踪错误:', error);
      let errorMsg = '位置跟踪失败';
      if (error.code === error.PERMISSION_DENIED) {
        errorMsg = '位置权限被拒绝';
      } else if (error.code === error.POSITION_UNAVAILABLE) {
        errorMsg = '无法获取位置信息';
      } else if (error.code === error.TIMEOUT) {
        errorMsg = '位置获取超时';
      }
      showStatus(errorMsg, 'warning');
    },
    options
  );
  
  updateGPSDisplay();
}

function stopLocationTracking() {
  if (geolocationWatchId !== null) {
    navigator.geolocation.clearWatch(geolocationWatchId);
    geolocationWatchId = null;
  }
  currentLocation = null;
}

function updateGPSDisplay() {
  const latElement = document.getElementById('gps-latitude');
  const lonElement = document.getElementById('gps-longitude');
  const accElement = document.getElementById('gps-accuracy');
  
  if (currentLocation) {
    if (latElement) {
      latElement.textContent = formatLatitude(currentLocation.latitude);
    }
    if (lonElement) {
      lonElement.textContent = formatLongitude(currentLocation.longitude);
    }
    if (accElement) {
      accElement.textContent = `${currentLocation.accuracy ? currentLocation.accuracy.toFixed(1) : '--'}米`;
    }
  } else {
    if (latElement) latElement.textContent = '--';
    if (lonElement) lonElement.textContent = '--';
    if (accElement) accElement.textContent = '--';
  }
}

function updateCameraPositionFromLocation() {
  if (!isARMode || !viewer || !currentLocation) return;

  const finalLatitude = currentLocation.latitude + (calibrationLatitude - DEFAULT_AR_LATITUDE);
  const finalLongitude = currentLocation.longitude + (calibrationLongitude - DEFAULT_AR_LONGITUDE);
  const finalHeight = (currentLocation.altitude || 0) + cameraHeight + calibrationHeightOffset;

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      finalLongitude,
      finalLatitude,
      finalHeight
    )
  });
  
  updateGPSDisplay();
}

const DEFAULT_AR_LATITUDE = 27.968858;
const DEFAULT_AR_LONGITUDE = 120.670331;

async function enterARMode() {
  if (isARMode) return;

  try {
    showLoading('正在启动AR模式...');
    
    originalCameraPosition = viewer.camera.position.clone();
    originalCameraOrientation = {
      heading: viewer.camera.heading,
      pitch: viewer.camera.pitch,
      roll: viewer.camera.roll
    };
    
    originalBasemapOpacity = viewer.imageryLayers.get(0)?.alpha || 1;
    
    let cameraStarted = false;
    if (videoSource === 'camera') {
      showLoading('正在请求摄像头权限...');
      try {
        cameraStarted = await startCamera();
      } catch (cameraError) {
        console.warn('摄像头启动失败:', cameraError);
        const isHttps = window.location.protocol === 'https:';
        if (!isHttps) {
          showStatus('⚠️ 需要HTTPS连接才能访问摄像头！请使用ngrok等工具提供HTTPS隧道', 'error');
        } else {
          showStatus('摄像头访问被拒绝，请检查浏览器权限设置', 'warning');
        }
      }
    } else if (videoFileUrl) {
      loadVideoFile(videoFileUrl);
      cameraStarted = true;
    }
    
    showLoading('正在初始化场景...');
    
    const canvas = viewer.scene.canvas;
    canvas.style.backgroundColor = 'transparent';
    
    viewer.scene.globe.baseColor = new Cesium.Color(0, 0, 0, 0);
    viewer.scene.globe.translucency.enabled = true;
    viewer.scene.globe.translucency.frontFaceAlpha = 0;
    viewer.scene.globe.translucency.backFaceAlpha = 0;
    viewer.scene.globe.showGroundAtmosphere = false;
    
    viewer.scene.skyAtmosphere.show = false;
    viewer.scene.skyBox.show = false;
    viewer.scene.sun.show = false;
    viewer.scene.moon.show = false;
    
    for (let i = 0; i < viewer.imageryLayers.length; i++) {
      viewer.imageryLayers.get(i).alpha = 0;
    }
    
    document.body.classList.add('ar-mode');
    
    const videoElement = document.getElementById('video-background');
    if (videoElement) {
      videoElement.style.display = 'block';
      videoElement.style.zIndex = '1';
    }
    
    calibrationLatitude = DEFAULT_AR_LATITUDE;
    calibrationLongitude = DEFAULT_AR_LONGITUDE;
    originalCalibrationLatitude = DEFAULT_AR_LATITUDE;
    originalCalibrationLongitude = DEFAULT_AR_LONGITUDE;
    
    cameraHeight = 1.7 + calibrationHeightOffset;
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        DEFAULT_AR_LONGITUDE,
        DEFAULT_AR_LATITUDE,
        cameraHeight
      ),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-15),
        roll: 0
      }
    });
    
    showLoading('正在检测传感器...');
    
    let gyroSupported = false;
    try {
      gyroSupported = await checkGyroscopeSupport();
    } catch (sensorError) {
      console.warn('陀螺仪检测失败:', sensorError);
      showStatus('传感器不可用，请使用手动校准', 'warning');
    }
    
    if (gyroSupported) {
      startOrientationTracking();
      manualMode = false;
    } else {
      manualMode = true;
    }
    
    showLoading('正在启动位置跟踪...');
    startLocationTracking();
    
    isARMode = true;
    updateARControls();
    updateGPSDisplay();
    hideLoading();
    
    showStatus(`AR模式已启动，位置: ${formatLatitude(DEFAULT_AR_LATITUDE)}, ${formatLongitude(DEFAULT_AR_LONGITUDE)}`, 'success');
    
  } catch (error) {
    console.error('进入AR模式失败:', error);
    hideLoading();
    showStatus('进入AR模式失败: ' + (error.message || '未知错误'), 'error');
    exitARMode();
  }
}

function exitARMode() {
  if (!isARMode) return;

  isARMode = false;
  manualMode = false;
  
  stopCamera();
  const videoElement = document.getElementById('video-background');
  if (videoElement) {
    videoElement.pause();
    videoElement.style.display = 'none';
  }
  stopOrientationTracking();
  stopLocationTracking();
  
  document.body.classList.remove('ar-mode');
  
  const canvas = viewer.scene.canvas;
  canvas.style.backgroundColor = '';
  viewer.scene.globe.baseColor = new Cesium.Color(0.2, 0.3, 0.4, 1.0);
  viewer.scene.globe.translucency.enabled = false;
  viewer.scene.globe.showGroundAtmosphere = true;
  
  viewer.scene.skyAtmosphere.show = true;
  viewer.scene.skyBox.show = true;
  viewer.scene.sun.show = true;
  viewer.scene.moon.show = true;
  
  for (let i = 0; i < viewer.imageryLayers.length; i++) {
    viewer.imageryLayers.get(i).alpha = originalBasemapOpacity;
  }
  
  const videoElement = document.getElementById('video-background');
  if (videoElement) {
    videoElement.style.display = 'none';
  }
  
  if (originalCameraPosition && originalCameraOrientation) {
    viewer.camera.setView({
      destination: originalCameraPosition,
      orientation: originalCameraOrientation
    });
  }
  
  document.getElementById('calibration-panel').style.display = 'none';
  
  updateARControls();
  showStatus('已退出AR模式', 'info');
}

function updateARControls() {
  const arControls = document.getElementById('ar-controls');
  if (!arControls) return;

  if (isARMode) {
    arControls.innerHTML = `
      <button class="ar-button calibrate" id="btn-calibrate">手动校准</button>
      <button class="ar-button exit" id="btn-exit-ar">退出AR模式</button>
    `;
    
    document.getElementById('btn-calibrate')?.addEventListener('click', openCalibrationPanel);
    document.getElementById('btn-exit-ar')?.addEventListener('click', exitARMode);
  } else {
    arControls.innerHTML = `
      <button class="ar-button" id="btn-enter-ar">
        <span class="ar-icon">📷</span>
        手机AR模式
      </button>
    `;
    document.getElementById('btn-enter-ar')?.addEventListener('click', () => {
      if (!checkGuideSeen()) {
        showARGuide();
      } else {
        enterARMode();
      }
    });
  }
}

function openCalibrationPanel() {
  const panel = document.getElementById('calibration-panel');
  if (panel) {
    panel.style.display = 'block';
    manualMode = true;
    initJoystick();
    updateHeightDisplay();
    
    const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.position);
    calibrationLatitude = Cesium.Math.toDegrees(cartographic.latitude);
    calibrationLongitude = Cesium.Math.toDegrees(cartographic.longitude);
    originalCalibrationLatitude = calibrationLatitude;
    originalCalibrationLongitude = calibrationLongitude;
    updateLocationDisplay();
    
    initTabs();
  }
}

function closeCalibrationPanel(save = true) {
  const panel = document.getElementById('calibration-panel');
  if (panel) {
    panel.style.display = 'none';
  }
  
  if (save) {
    showStatus('校准已保存', 'success');
  } else {
    calibrationHeadingOffset = 0;
    calibrationHeightOffset = 0;
    calibrationLatitude = originalCalibrationLatitude;
    calibrationLongitude = originalCalibrationLongitude;
  }
  
  manualMode = !gyroscopeAvailable;
}

function initJoystick() {
  const joystick = document.getElementById('joystick');
  const knob = document.getElementById('joystick-knob');
  if (!joystick || !knob) return;

  let isDragging = false;
  const joystickCenterX = 60;
  const joystickCenterY = 60;
  const joystickRadius = 40;

  const handleStart = (e) => {
    isDragging = true;
    e.preventDefault();
  };

  const handleMove = (e) => {
    if (!isDragging || !isARMode) return;
    e.preventDefault();

    const touch = e.touches ? e.touches[0] : e;
    const rect = joystick.getBoundingClientRect();
    let x = touch.clientX - rect.left - joystickCenterX;
    let y = touch.clientY - rect.top - joystickCenterY;

    const distance = Math.sqrt(x * x + y * y);
    if (distance > joystickRadius) {
      x = (x / distance) * joystickRadius;
      y = (y / distance) * joystickRadius;
    }

    knob.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;

    const headingAdjustment = (x / joystickRadius) * 0.02;
    calibrationHeadingOffset += headingAdjustment;
    
    viewer.camera.setView({
      orientation: {
        heading: viewer.camera.heading + headingAdjustment,
        pitch: viewer.camera.pitch,
        roll: 0
      }
    });
  };

  const handleEnd = () => {
    isDragging = false;
    knob.style.transform = 'translate(-50%, -50%)';
  };

  joystick.addEventListener('mousedown', handleStart);
  joystick.addEventListener('touchstart', handleStart);
  document.addEventListener('mousemove', handleMove);
  document.addEventListener('touchmove', handleMove);
  document.addEventListener('mouseup', handleEnd);
  document.addEventListener('touchend', handleEnd);
}

function updateHeightDisplay() {
  const display = document.getElementById('height-display');
  if (display) {
    display.textContent = `高度: ${(cameraHeight + calibrationHeightOffset).toFixed(1)}米`;
  }
}

function adjustHeight(delta) {
  if (!isARMode || !viewer) return;
  
  calibrationHeightOffset += delta;
  calibrationHeightOffset = Math.max(-0.5, Math.min(0.5, calibrationHeightOffset));
  
  const currentPosition = Cesium.Cartographic.fromCartesian(viewer.camera.position);
  const newHeight = currentPosition.height + delta;
  
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromRadians(
      currentPosition.longitude,
      currentPosition.latitude,
      newHeight
    )
  });
  
  updateHeightDisplay();
}

function formatLatitude(lat) {
  const direction = lat >= 0 ? 'N' : 'S';
  return `${Math.abs(lat).toFixed(4)}°${direction}`;
}

function formatLongitude(lon) {
  const direction = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lon).toFixed(4)}°${direction}`;
}

function validateLatitude(lat) {
  const num = parseFloat(lat);
  return !isNaN(num) && num >= -90 && num <= 90;
}

function validateLongitude(lon) {
  const num = parseFloat(lon);
  return !isNaN(num) && num >= -180 && num <= 180;
}

function updateLocationDisplay() {
  const display = document.getElementById('location-display');
  if (display) {
    display.textContent = `纬度: ${formatLatitude(calibrationLatitude)}, 经度: ${formatLongitude(calibrationLongitude)}`;
  }
  
  const latInput = document.getElementById('input-lat');
  const lonInput = document.getElementById('input-lon');
  if (latInput) latInput.value = calibrationLatitude.toFixed(6);
  if (lonInput) lonInput.value = calibrationLongitude.toFixed(6);
}

function adjustLatitude(delta) {
  calibrationLatitude += delta;
  calibrationLatitude = Math.max(-90, Math.min(90, calibrationLatitude));
  updateLocationDisplay();
  
  const latInput = document.getElementById('input-lat');
  if (latInput) latInput.classList.remove('error');
}

function adjustLongitude(delta) {
  calibrationLongitude += delta;
  calibrationLongitude = Math.max(-180, Math.min(180, calibrationLongitude));
  updateLocationDisplay();
  
  const lonInput = document.getElementById('input-lon');
  if (lonInput) lonInput.classList.remove('error');
}

function applyLocation() {
  const latInput = document.getElementById('input-lat');
  const lonInput = document.getElementById('input-lon');
  
  const latVal = latInput?.value;
  const lonVal = lonInput?.value;
  
  let hasError = false;
  
  if (!validateLatitude(latVal)) {
    if (latInput) latInput.classList.add('error');
    hasError = true;
  } else {
    if (latInput) latInput.classList.remove('error');
    calibrationLatitude = parseFloat(latVal);
  }
  
  if (!validateLongitude(lonVal)) {
    if (lonInput) lonInput.classList.add('error');
    hasError = true;
  } else {
    if (lonInput) lonInput.classList.remove('error');
    calibrationLongitude = parseFloat(lonVal);
  }
  
  if (hasError) {
    showStatus('请输入有效的经纬度值', 'error');
    return;
  }
  
  updateLocationDisplay();
  applyLocationToCamera();
  showStatus('位置已更新', 'success');
}

function resetLocation() {
  calibrationLatitude = originalCalibrationLatitude;
  calibrationLongitude = originalCalibrationLongitude;
  updateLocationDisplay();
  
  const latInput = document.getElementById('input-lat');
  const lonInput = document.getElementById('input-lon');
  if (latInput) latInput.classList.remove('error');
  if (lonInput) lonInput.classList.remove('error');
  
  showStatus('位置已重置', 'info');
}

function applyLocationToCamera() {
  if (!viewer || !isARMode) return;
  
  const currentPosition = Cesium.Cartographic.fromCartesian(viewer.camera.position);
  const currentHeight = currentPosition.height;
  
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      calibrationLongitude,
      calibrationLatitude,
      currentHeight
    )
  });
}

function openMapPicker() {
  const modal = document.getElementById('map-picker-modal');
  if (!modal) return;
  
  modal.classList.add('active');
  initMapPicker();
}

function closeMapPicker() {
  const modal = document.getElementById('map-picker-modal');
  if (modal) {
    modal.classList.remove('active');
  }
  
  if (mapPickerViewer) {
    mapPickerViewer.destroy();
    mapPickerViewer = null;
  }
  mapPickerMarker = null;
}

async function initMapPicker() {
  const container = document.getElementById('map-picker-cesium');
  if (!container) return;
  
  try {
    mapPickerViewer = new Cesium.Viewer('map-picker-cesium', {
      terrainProvider: await Cesium.createWorldTerrainAsync(),
      animation: false,
      timeline: false,
      baseLayerPicker: true,
      geocoder: true,
      homeButton: true,
      sceneModePicker: true,
      navigationHelpButton: false,
      fullscreenButton: false,
      vrButton: false
    });
    
    mapPickerViewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        calibrationLongitude,
        calibrationLatitude,
        1000
      )
    });
    
    const handler = new Cesium.ScreenSpaceEventHandler(mapPickerViewer.scene.canvas);
    handler.setInputAction((movement) => {
      const pickedPosition = mapPickerViewer.scene.pickPosition(movement.position);
      if (Cesium.defined(pickedPosition)) {
        const cartographic = Cesium.Cartographic.fromCartesian(pickedPosition);
        const lon = Cesium.Math.toDegrees(cartographic.longitude);
        const lat = Cesium.Math.toDegrees(cartographic.latitude);
        
        mapPickerSelectedLatitude = lat;
        mapPickerSelectedLongitude = lon;
        
        updateMapPickerInfo(lat, lon);
        updateMapPickerMarker(lon, lat);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    
    updateMapPickerInfo(calibrationLatitude, calibrationLongitude);
    
  } catch (error) {
    console.error('初始化地图拾取器失败:', error);
    showStatus('地图拾取器初始化失败', 'error');
  }
}

function updateMapPickerInfo(lat, lon) {
  const info = document.getElementById('map-picker-info');
  if (info) {
    info.innerHTML = `
      纬度: ${formatLatitude(lat)}<br>
      经度: ${formatLongitude(lon)}
    `;
  }
}

function updateMapPickerMarker(lon, lat) {
  if (!mapPickerViewer) return;
  
  if (mapPickerMarker) {
    mapPickerViewer.entities.remove(mapPickerMarker);
  }
  
  mapPickerMarker = mapPickerViewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lon, lat),
    point: {
      pixelSize: 15,
      color: Cesium.Color.RED,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 3
    }
  });
}

function selectMapPickerCoord() {
  calibrationLatitude = mapPickerSelectedLatitude;
  calibrationLongitude = mapPickerSelectedLongitude;
  updateLocationDisplay();
  closeMapPicker();
  showStatus('已从地图选择坐标', 'success');
}

function initTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
      });
      document.getElementById(tabId)?.classList.add('active');
    });
  });
}

function zoomToDataset(datasetName) {
  currentDataset = datasetName;
  const entities = datasetEntitiesMap[datasetName];
  if (entities && entities.length > 0) {
    console.log(`跳转到 ${datasetName}`);
    viewer.zoomTo(entities);
    
    document.getElementById('btn-dongtou')?.classList.toggle('active', datasetName === '洞头区管网');
    document.getElementById('btn-wutian')?.classList.toggle('active', datasetName === '梧田街道管网');
  } else {
    console.warn(`数据集 ${datasetName} 没有实体或未加载`);
  }
}

function updateOpacity(opacity) {
  for (let i = 0; i < viewer.imageryLayers.length; i++) {
    const layer = viewer.imageryLayers.get(i);
    layer.alpha = opacity;
  }
}

async function initViewer() {
  console.log('正在初始化 Cesium 查看器...');
  
  viewer = new Cesium.Viewer('app', {
    terrainProvider: await Cesium.createWorldTerrainAsync(),
    animation: false,
    timeline: false,
    baseLayerPicker: true,
    geocoder: true,
    homeButton: true,
    sceneModePicker: true,
    navigationHelpButton: false,
    fullscreenButton: true,
    vrButton: false
  });

  try {
    console.log('正在加载 OSM Buildings...');
    const osmBuildings = await Cesium.createOsmBuildingsAsync();
    viewer.scene.primitives.add(osmBuildings);
    
    osmBuildings.style = new Cesium.Cesium3DTileStyle({
      color: 'color("rgba(255, 255, 255, 0.4)")'
    });
    
    console.log('OSM Buildings 加载成功');
  } catch (error) {
    console.warn('OSM Buildings 加载失败:', error);
  }

  try {
    const dataSources = [
      { name: '洞头区管网', url: 'zlsgs_t_system_pipe_line.json' },
      { name: '梧田街道管网', url: 'highway.geojsonl.json' }
    ];

    console.log('开始加载多数据集...');
    const { allEntities: loadedAll, datasetEntitiesMap: loadedMap } = await loadPipeNetwork(viewer, dataSources);
    allEntities = loadedAll;
    datasetEntitiesMap = loadedMap;

    if (allEntities.length > 0) {
      console.log(`全部加载完成，总实体数: ${allEntities.length}`);
      viewer.zoomTo(allEntities);
    } else {
      console.warn('没有成功加载任何管线实体');
    }
  } catch (error) {
    console.error('初始化过程中出错:', error);
  }

  const btnDongtou = document.getElementById('btn-dongtou');
  const btnWutian = document.getElementById('btn-wutian');
  const opacitySlider = document.getElementById('opacity-slider');
  const opacityValue = document.getElementById('opacity-value');

  if (btnDongtou) {
    btnDongtou.addEventListener('click', () => zoomToDataset('洞头区管网'));
  }

  if (btnWutian) {
    btnWutian.addEventListener('click', () => zoomToDataset('梧田街道管网'));
  }

  if (opacitySlider && opacityValue) {
    opacitySlider.addEventListener('input', () => {
      const opacity = parseFloat(opacitySlider.value);
      opacityValue.textContent = opacity.toFixed(2);
      if (!isARMode) {
        originalBasemapOpacity = opacity;
        updateOpacity(opacity);
      }
    });
  }

  document.getElementById('btn-cancel-calibrate')?.addEventListener('click', () => closeCalibrationPanel(false));
  document.getElementById('btn-done-calibrate')?.addEventListener('click', () => closeCalibrationPanel(true));
  document.getElementById('btn-height-up')?.addEventListener('click', () => adjustHeight(0.1));
  document.getElementById('btn-height-down')?.addEventListener('click', () => adjustHeight(-0.1));
  
  document.getElementById('btn-lat-up')?.addEventListener('click', () => adjustLatitude(0.0001));
  document.getElementById('btn-lat-down')?.addEventListener('click', () => adjustLatitude(-0.0001));
  document.getElementById('btn-lon-up')?.addEventListener('click', () => adjustLongitude(0.0001));
  document.getElementById('btn-lon-down')?.addEventListener('click', () => adjustLongitude(-0.0001));
  
  document.getElementById('btn-apply-loc')?.addEventListener('click', applyLocation);
  document.getElementById('btn-cancel-loc')?.addEventListener('click', resetLocation);
  document.getElementById('btn-pick-map')?.addEventListener('click', openMapPicker);
  
  document.getElementById('btn-close-map-picker')?.addEventListener('click', closeMapPicker);
  document.getElementById('btn-select-coord')?.addEventListener('click', selectMapPickerCoord);
  
  document.getElementById('input-lat')?.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val) && val >= -90 && val <= 90) {
      e.target.classList.remove('error');
    }
  });
  
  document.getElementById('input-lon')?.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val) && val >= -180 && val <= 180) {
      e.target.classList.remove('error');
    }
  });
  
  // 视频控制事件
  document.getElementById('btn-source-camera')?.addEventListener('click', () => switchVideoSource('camera'));
  document.getElementById('btn-source-file')?.addEventListener('click', () => switchVideoSource('file'));
  
  document.getElementById('video-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      document.getElementById('video-file-info').textContent = `已选择: ${file.name}`;
      loadVideoFile(file);
    }
  });
  
  const videoOpacitySlider = document.getElementById('video-opacity-slider');
  const videoOpacityValue = document.getElementById('video-opacity-value');
  if (videoOpacitySlider && videoOpacityValue) {
    videoOpacitySlider.addEventListener('input', () => {
      const opacity = parseFloat(videoOpacitySlider.value);
      videoOpacityValue.textContent = opacity.toFixed(2);
      setVideoOpacity(opacity);
    });
  }
  
  document.getElementById('btn-video-play')?.addEventListener('click', playVideo);
  document.getElementById('btn-video-pause')?.addEventListener('click', pauseVideo);

  initGuideEvents();
  updateARControls();
  
  try {
    hasSeenGuide = localStorage.getItem('arGuideSeen') === 'true';
  } catch (e) {
    console.warn('无法读取localStorage:', e);
  }

  return viewer;
}

initViewer();
