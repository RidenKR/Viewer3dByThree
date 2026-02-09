/**
 * main.js - Three.js 3D Viewer 엔트리 포인트
 * 모든 모듈 초기화 및 UI 이벤트 연결
 */
import { Viewer } from './core/Viewer.js';
import { SectionPlaneManager } from './tools/SectionPlaneManager.js';
import { MeasurementManager } from './tools/MeasurementManager.js';
import { DistanceMeasurement } from './tools/DistanceMeasurement.js';
import { EdgeMeasurement } from './tools/EdgeMeasurement.js';
import { DiameterMeasurement } from './tools/DiameterMeasurement.js';
import { Diameter2Point } from './tools/Diameter2Point.js';
import { AnnotationManager } from './tools/AnnotationManager.js';
import { parseCSV, renderBOMTable } from './utils/bomLoader.js';

// ============================================================
// Global State
// ============================================================
let viewer = null;
let sectionPlaneManager = null;
let measurementManager = null;
let distanceMeasurement = null;
let edgeMeasurement = null;
let diameterMeasurement = null;
let diameter2Point = null;
let annotationManager = null;

let activeTool = null; // 현재 활성 측정/어노테이션 도구
let lastMeasurementCount = 0; // 측정 리스트 갱신 체크용

// ============================================================
// Initialization
// ============================================================
function init() {
  // Viewer 생성
  viewer = new Viewer('canvas-container');

  // Section Plane Manager
  sectionPlaneManager = new SectionPlaneManager(viewer);
  viewer.sectionPlaneManager = sectionPlaneManager; // EdgeMeasurement에서 참조

  // Measurement Manager
  measurementManager = new MeasurementManager(viewer, 'labels-container');

  // Distance Measurement (2점 거리)
  distanceMeasurement = new DistanceMeasurement(viewer, measurementManager);

  // Edge Measurement (1-click Edge)
  edgeMeasurement = new EdgeMeasurement(viewer, measurementManager);

  // Diameter Measurement (3점)
  diameterMeasurement = new DiameterMeasurement(viewer, measurementManager);

  // Diameter 2-Point
  diameter2Point = new Diameter2Point(viewer, measurementManager);

  // Annotation Manager
  annotationManager = new AnnotationManager(viewer, 'labels-container');

  // 콜백 등록
  viewer.onModelLoaded(onModelLoaded);
  viewer.onFPSUpdate(onFPSUpdate);

  // UI 이벤트 바인딩
  setupToolbarEvents();
  setupBottomToolbarEvents();
  setupDropdowns();
  setupSectionPanel();
  setupSettingsPanel();
  setupBomPanel();
  setupMeasurementListPanel();

  // URL 파라미터로 모델 로드
  checkURLModel();

  updateStatus('Ready');
}

// ============================================================
// Model Loading
// ============================================================
function onModelLoaded(result) {
  measurementManager.setMetricsScale(result.metricsScale);
  sectionPlaneManager.setModelBounds(result.bounds);

  const fileName = result.fileName || 'Unknown';
  const unitInfo = result.metricsUnit || 'mm';
  document.getElementById('model-info').textContent = `${fileName} | ${unitInfo}`;
  updateStatus(`Model loaded: ${fileName}`);

  hideLoading();
}

function onFPSUpdate(fps) {
  const statusText = document.getElementById('status-text');
  if (statusText) {
    const currentText = statusText.textContent.replace(/\s*\|\s*\d+ FPS$/, '');
    statusText.textContent = `${currentText} | ${fps} FPS`;
  }
}

function checkURLModel() {
  const params = new URLSearchParams(window.location.search);
  const modelUrl = params.get('model');
  if (modelUrl) {
    loadModelFromURL(modelUrl);
  }
}

async function loadModelFromURL(url) {
  showLoading('Loading model...');
  try {
    await viewer.loadModelFromURL(url, (percent) => {
      updateLoadingText(`Loading... ${percent}%`);
    });
  } catch (error) {
    console.error('Model load error:', error);
    updateStatus(`Error: ${error.message}`);
    hideLoading();
  }
}

async function loadModelFromFile(file) {
  showLoading(`Loading ${file.name}...`);
  try {
    await viewer.loadModelFromFile(file, (percent) => {
      updateLoadingText(`Loading... ${percent}%`);
    });
  } catch (error) {
    console.error('Model load error:', error);
    updateStatus(`Error: ${error.message}`);
    hideLoading();
  }
}

// ============================================================
// Top Toolbar
// ============================================================
function setupToolbarEvents() {
  const btnOpen = document.getElementById('btn-open-file');
  const fileInput = document.getElementById('file-input');

  if (btnOpen && fileInput) {
    btnOpen.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        loadModelFromFile(file);
        fileInput.value = '';
      }
    });
  }
}

// ============================================================
// Bottom Toolbar
// ============================================================
function setupBottomToolbarEvents() {
  // Home 버튼 (전체 리셋 - 파일을 새로 연 것처럼)
  document.getElementById('btn-bottom-home')?.addEventListener('click', () => {
    resetAll();
  });

  // Projection 토글
  const btnProjection = document.getElementById('btn-bottom-projection');
  if (btnProjection) {
    btnProjection.addEventListener('click', () => {
      const mode = viewer.cameraManager.toggleProjection();
      btnProjection.classList.toggle('btn-active', mode === 'orthographic');
      updateStatus(`Projection: ${mode}`);
    });
  }

  // Fit All 버튼
  document.getElementById('btn-bottom-fit')?.addEventListener('click', () => {
    viewer.cameraManager.fitAll();
  });

  // Section 버튼 (패널 토글)
  const btnSection = document.getElementById('btn-bottom-section');
  if (btnSection) {
    btnSection.addEventListener('click', () => {
      togglePanel('section-panel');
      btnSection.classList.toggle('btn-active');
    });
  }

  // Snapshot 버튼
  document.getElementById('btn-bottom-snapshot')?.addEventListener('click', takeSnapshot);
}

// ============================================================
// Dropdown Management
// ============================================================
const openDropdowns = new Set();

function setupDropdowns() {
  // Camera View 드롭다운
  setupDropdown('btn-bottom-camera-view', 'camera-view-dropdown', (option) => {
    const view = option.dataset.view;
    if (view) {
      viewer.cameraManager.setCameraView(view);
      updateStatus(`View: ${view}`);
    }
  }, '.camera-view-option');

  // View Mode 드롭다운
  setupDropdown('btn-bottom-view-mode', 'view-mode-dropdown', (option) => {
    const mode = option.dataset.mode;
    if (mode) {
      viewer.setViewMode(mode);
      updateStatus(`View Mode: ${mode}`);
    }
  }, '.view-mode-option');

  // Measure Menu 드롭다운
  setupDropdown('btn-bottom-measure-menu', 'measure-menu-dropdown', (option) => {
    const type = option.dataset.measure;
    if (type) activateMeasureTool(type);
  }, '.measure-menu-option');

  // Annotate Menu 드롭다운
  setupDropdown('btn-bottom-annotate', 'annotate-menu-dropdown', (option) => {
    const type = option.dataset.annotate;
    if (type) {
      deactivateAllTools();
      annotationManager.activate(type);
      activeTool = `annotate-${type}`;
      document.getElementById('btn-bottom-annotate')?.classList.add('btn-active');
      updateStatus(`Annotation: ${type}`);
    }
  }, '.annotate-menu-option');

  // BOM 드롭다운
  setupDropdown('btn-bottom-bom', 'bom-dropdown', (option) => {
    const action = option.dataset.action;
    if (action === 'view') togglePanel('bom-panel');
    else if (action === 'select') document.getElementById('bom-file-input')?.click();
  }, '.bom-option');

  // Settings 버튼 (패널 토글)
  const btnSettings = document.getElementById('btn-bottom-settings');
  if (btnSettings) {
    btnSettings.addEventListener('click', () => {
      togglePanel('settings-panel');
      btnSettings.classList.toggle('btn-active');
    });
  }

  // 외부 클릭 시 드롭다운 닫기
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.bottom-toolbar-section')) {
      closeAllDropdowns();
    }
  });
}

function setupDropdown(buttonId, dropdownId, onSelect, optionSelector) {
  const btn = document.getElementById(buttonId);
  const dropdown = document.getElementById(dropdownId);
  if (!btn || !dropdown) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !dropdown.classList.contains('hidden');
    closeAllDropdowns();
    if (!isOpen) {
      dropdown.classList.remove('hidden');
      openDropdowns.add(dropdownId);
    }
  });

  const options = dropdown.querySelectorAll(optionSelector);
  options.forEach(option => {
    option.addEventListener('click', (e) => {
      e.stopPropagation();
      onSelect(option);
      dropdown.classList.add('hidden');
      openDropdowns.delete(dropdownId);
    });
  });
}

function closeAllDropdowns() {
  openDropdowns.forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
  openDropdowns.clear();
}

// ============================================================
// Measurement Tools
// ============================================================
function activateMeasureTool(type) {
  deactivateAllTools();

  switch (type) {
    case 'distance':
      distanceMeasurement.activate();
      activeTool = 'distance';
      updateStatus('Distance: Click first point');
      break;
    case 'edge':
      edgeMeasurement.activate();
      activeTool = 'edge';
      updateStatus('Edge: Hover and click edge');
      break;
    case 'diameter3p':
      diameterMeasurement.activate();
      activeTool = 'diameter3p';
      updateStatus('Diameter (3pt): Click 3 points on arc');
      break;
    case 'diameter2p':
      diameter2Point.activate();
      activeTool = 'diameter2p';
      updateStatus('Diameter (2pt): Click 2 endpoints');
      break;
  }

  document.getElementById('btn-bottom-measure-menu')?.classList.add('btn-active');
  showPanel('measurement-list-panel');
  updateMeasurementList();
}

function deactivateAllTools() {
  distanceMeasurement?.deactivate();
  edgeMeasurement?.deactivate();
  diameterMeasurement?.deactivate();
  diameter2Point?.deactivate();
  annotationManager?.deactivate();
  activeTool = null;
  document.getElementById('btn-bottom-measure-menu')?.classList.remove('btn-active');
  document.getElementById('btn-bottom-annotate')?.classList.remove('btn-active');
}

// ============================================================
// Reset All (Home)
// ============================================================
function resetAll() {
  // 1. 활성 도구 비활성화
  deactivateAllTools();

  // 2. 측정 전체 삭제
  measurementManager?.clearAll();
  lastMeasurementCount = 0;
  updateMeasurementList();

  // 3. 섹션 플레인 전체 삭제
  sectionPlaneManager?.clearAll();
  // 섹션 패널 UI 리셋
  document.querySelectorAll('.section-axis-btn').forEach((btn) => {
    btn.classList.remove('btn-active');
  });
  document.getElementById('btn-bottom-section')?.classList.remove('btn-active');

  // 4. 어노테이션 전체 삭제
  annotationManager?.clearAll?.();

  // 5. 프로젝션을 perspective로 리셋
  if (viewer.cameraManager.projection === 'orthographic') {
    viewer.cameraManager.toggleProjection();
    document.getElementById('btn-bottom-projection')?.classList.remove('btn-active');
  }

  // 6. 뷰 모드를 shaded로 리셋
  viewer.setViewMode('shaded');

  // 7. 카메라를 초기 상태로 복원
  viewer.cameraManager.restoreInitialState();

  // 8. 패널 닫기
  closeAllDropdowns();

  updateStatus('Reset to initial state');
}

// ============================================================
// Measurement List Panel
// ============================================================
function setupMeasurementListPanel() {
  document.getElementById('measurement-list-close')?.addEventListener('click', () => {
    hidePanel('measurement-list-panel');
    deactivateAllTools();
  });

  document.getElementById('btn-measurement-clear-all')?.addEventListener('click', () => {
    measurementManager.clearAll();
    lastMeasurementCount = 0;
    updateMeasurementList();
  });

  // 측정 추가 감지 (매 프레임 체크는 비효율, count 변경 시만 갱신)
  viewer.onUpdate(() => {
    if (measurementManager.count !== lastMeasurementCount) {
      lastMeasurementCount = measurementManager.count;
      updateMeasurementList();
    }
  });
}

function updateMeasurementList() {
  const listEl = document.getElementById('measurement-list');
  const totalEl = document.getElementById('measurement-list-total');
  const totalValueEl = document.getElementById('measurement-total-value');
  if (!listEl) return;

  const measurements = measurementManager.measurements;
  listEl.innerHTML = '';

  let totalLength = 0;

  measurements.forEach((m) => {
    const li = document.createElement('li');
    li.className = 'measurement-list-item';

    const typeLabel = m.type === 'edge' ? 'Edge' : m.type === 'diameter' ? 'Diameter' : 'Distance';
    const formattedValue = measurementManager.formatValue(m.length);

    li.innerHTML = `
      <span class="measurement-item-label">${typeLabel}</span>
      <span class="measurement-item-value ${m.type}">${formattedValue}</span>
      <button class="measurement-item-delete" data-id="${m.id}" title="삭제">&times;</button>
    `;

    li.querySelector('.measurement-item-delete').addEventListener('click', () => {
      measurementManager.removeMeasurement(m.id);
      lastMeasurementCount = measurementManager.count;
      updateMeasurementList();
    });

    listEl.appendChild(li);
    totalLength += m.length;
  });

  if (totalEl && totalValueEl) {
    if (measurements.length > 1) {
      totalEl.classList.remove('hidden');
      totalValueEl.textContent = measurementManager.formatValue(totalLength);
    } else {
      totalEl.classList.add('hidden');
    }
  }
}

// ============================================================
// Section Panel
// ============================================================
function setupSectionPanel() {
  document.getElementById('section-close')?.addEventListener('click', () => {
    hidePanel('section-panel');
    document.getElementById('btn-bottom-section')?.classList.remove('btn-active');
  });

  // 축 버튼 (X/Y/Z)
  document.querySelectorAll('.section-axis-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const axis = btn.dataset.axis;
      if (sectionPlaneManager.hasPlane(axis)) {
        sectionPlaneManager.removePlane(axis);
        btn.classList.remove('btn-active');
      } else {
        sectionPlaneManager.addPlane(axis);
        btn.classList.add('btn-active');
      }
      updateSectionPanelUI();
    });
  });

  // Clear All
  document.getElementById('btn-clear-sections')?.addEventListener('click', () => {
    sectionPlaneManager.clearAll();
    document.querySelectorAll('.section-axis-btn').forEach(b => b.classList.remove('btn-active'));
    updateSectionPanelUI();
  });

  // 기준면 보이기
  document.getElementById('chk-plane-mesh')?.addEventListener('change', (e) => {
    sectionPlaneManager.setHelperVisible(e.target.checked);
  });
}

function updateSectionPanelUI() {
  const listEl = document.getElementById('section-planes-list');
  if (!listEl) return;

  listEl.innerHTML = '';

  const activePlanes = sectionPlaneManager.getActivePlanes();
  if (activePlanes.length === 0) return;

  activePlanes.forEach(({ axis, position, flipped }) => {
    const div = document.createElement('div');
    div.className = 'section-plane-item';
    div.innerHTML = `
      <div class="section-plane-info">
        <span class="section-plane-axis">${axis.toUpperCase()}</span>
        <div class="section-plane-controls">
          <button class="section-plane-flip" data-axis="${axis}" title="방향 반전">${flipped ? '◀' : '▶'}</button>
          <button class="section-plane-remove" data-axis="${axis}" title="제거">&times;</button>
        </div>
      </div>
      <div class="section-plane-slider-container">
        <input type="range" class="section-plane-slider" min="-100" max="100" value="${position}" data-axis="${axis}" />
        <span class="section-plane-value">${position}%</span>
      </div>
    `;

    div.querySelector('.section-plane-slider').addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      sectionPlaneManager.setPosition(axis, val);
      div.querySelector('.section-plane-value').textContent = `${val}%`;
    });

    div.querySelector('.section-plane-flip').addEventListener('click', () => {
      sectionPlaneManager.flipPlane(axis);
      updateSectionPanelUI();
    });

    div.querySelector('.section-plane-remove').addEventListener('click', () => {
      sectionPlaneManager.removePlane(axis);
      document.querySelector(`.section-axis-btn[data-axis="${axis}"]`)?.classList.remove('btn-active');
      updateSectionPanelUI();
    });

    listEl.appendChild(div);
  });
}

// ============================================================
// Settings Panel
// ============================================================
function setupSettingsPanel() {
  document.getElementById('settings-close')?.addEventListener('click', () => {
    hidePanel('settings-panel');
    document.getElementById('btn-bottom-settings')?.classList.remove('btn-active');
  });

  // 표면 색상
  const colorInput = document.getElementById('material-color-input');
  const colorHex = document.getElementById('color-hex-value');
  if (colorInput) {
    colorInput.addEventListener('input', (e) => {
      viewer.setMaterialColor(e.target.value);
      if (colorHex) colorHex.textContent = e.target.value;
    });
  }

  // 모델 밝기
  const gammaSlider = document.getElementById('gamma-slider');
  const gammaValue = document.getElementById('gamma-value');
  if (gammaSlider) {
    gammaSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      viewer.setExposure(val);
      if (gammaValue) gammaValue.textContent = val.toFixed(1);
    });
  }

  // 기본값 복원
  document.getElementById('btn-material-reset')?.addEventListener('click', () => {
    if (colorInput) {
      colorInput.value = '#a6b3bf';
      if (colorHex) colorHex.textContent = '#a6b3bf';
    }
    if (gammaSlider) {
      gammaSlider.value = '1.0';
      if (gammaValue) gammaValue.textContent = '1.0';
    }
    viewer.setExposure(1.0);
    viewer.setMaterialColor('#a6b3bf');
  });
}

// ============================================================
// BOM Panel
// ============================================================
function setupBomPanel() {
  document.getElementById('bom-close')?.addEventListener('click', () => {
    hidePanel('bom-panel');
  });

  const bomFileInput = document.getElementById('bom-file-input');
  if (bomFileInput) {
    bomFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        loadBomFile(file);
        bomFileInput.value = '';
      }
    });
  }
}

async function loadBomFile(file) {
  try {
    const text = await file.text();
    const bomData = parseCSV(text);
    if (bomData.length > 0) {
      renderBOMTable(bomData, 'bom-table-body');
      showPanel('bom-panel');
      updateStatus(`BOM loaded: ${bomData.length} items`);
    } else {
      updateStatus('BOM: No data found');
    }
  } catch (error) {
    console.error('BOM load error:', error);
    updateStatus(`BOM Error: ${error.message}`);
  }
}

// ============================================================
// Snapshot
// ============================================================
function takeSnapshot() {
  const canvas = viewer.renderer.domElement;
  const camera = viewer.cameraManager.getActiveCamera();
  viewer.renderer.render(viewer.scene, camera);

  const link = document.createElement('a');
  link.download = `snapshot_${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();

  updateStatus('Snapshot saved');
}

// ============================================================
// Panel Management
// ============================================================
function togglePanel(panelId) {
  document.getElementById(panelId)?.classList.toggle('hidden');
}

function showPanel(panelId) {
  document.getElementById(panelId)?.classList.remove('hidden');
}

function hidePanel(panelId) {
  document.getElementById(panelId)?.classList.add('hidden');
}

// ============================================================
// UI Helpers
// ============================================================
function updateStatus(text) {
  const el = document.getElementById('status-text');
  if (el) el.textContent = text;
}

function showLoading(text) {
  document.getElementById('loading')?.classList.remove('hidden');
  const el = document.getElementById('loading-text');
  if (el) el.textContent = text || 'Loading...';
}

function hideLoading() {
  document.getElementById('loading')?.classList.add('hidden');
}

function updateLoadingText(text) {
  const el = document.getElementById('loading-text');
  if (el) el.textContent = text;
}

// ============================================================
// Keyboard Shortcuts
// ============================================================
document.addEventListener('keydown', (e) => {
  const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

  if (e.key === 'Escape') {
    if (activeTool) {
      deactivateAllTools();
      updateStatus('Tool deactivated');
    }
    closeAllDropdowns();
  }

  if (e.key === 'Delete' && e.ctrlKey) {
    measurementManager?.clearAll();
    lastMeasurementCount = 0;
    updateMeasurementList();
    updateStatus('All measurements cleared');
  }

  if (isInput) return;

  if (e.key === '1') {
    resetAll();
  }

  if (e.key === 'f') {
    viewer.cameraManager.fitAll();
  }
});

// ============================================================
// Start
// ============================================================
document.addEventListener('DOMContentLoaded', init);
