/**
 * BOM 데이터 로더 유틸리티
 *
 * CSV 파일을 로드하고 파싱하여 BOM 테이블에 표시
 */

/**
 * CSV 텍스트를 파싱하여 객체 배열로 변환
 * 간단한 3컬럼 형식 (No, Part Name, Quantity)에 최적화
 * @param {string} csvText - CSV 텍스트
 * @returns {Array<Object>} 파싱된 데이터 배열
 */
export function parseCSV(csvText) {
  const lines = csvText.trim().split('\n').filter(line => line.trim());
  if (lines.length < 2) {
    console.warn('CSV has less than 2 lines');
    return [];
  }

  console.log('Parsing CSV with', lines.length, 'lines');

  // 데이터 행 파싱 (헤더 스킵)
  const data = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // 첫 번째 쉼표로 No 분리
    const firstComma = line.indexOf(',');
    if (firstComma === -1) continue;

    const no = line.substring(0, firstComma).trim();
    const rest = line.substring(firstComma + 1);

    // 마지막 쉼표로 Quantity 분리 (Part Name은 중간에 있음)
    const lastComma = rest.lastIndexOf(',');
    if (lastComma === -1) continue;

    const partName = rest.substring(0, lastComma).trim();
    const quantity = rest.substring(lastComma + 1).trim();

    const row = {
      'No': no,
      'Part Name': partName,
      'Quantity': quantity
    };

    data.push(row);
    console.log(`Row ${i}:`, row);
  }

  console.log('Parsed', data.length, 'rows');
  return data;
}

/**
 * BOM CSV 파일을 로드하여 테이블에 표시
 * @param {string} csvPath - CSV 파일 경로
 * @param {string} tableBodyId - 테이블 body 요소의 ID (기본값: 'bom-table-body')
 */
export async function loadBOMData(csvPath, tableBodyId = 'bom-table-body') {
  try {
    const response = await fetch(csvPath);
    if (!response.ok) {
      throw new Error(`Failed to load BOM file: ${csvPath}`);
    }

    const csvText = await response.text();
    const bomData = parseCSV(csvText);

    if (bomData.length === 0) {
      console.warn('No BOM data found in CSV');
      return;
    }

    // 테이블에 데이터 추가
    renderBOMTable(bomData, tableBodyId);
    console.log(`BOM data loaded successfully: ${bomData.length} items`);

    return bomData;
  } catch (error) {
    console.error('Error loading BOM data:', error);
    throw error;
  }
}

/**
 * BOM 데이터를 테이블에 렌더링
 * @param {Array<Object>} bomData - BOM 데이터 배열
 * @param {string} tableBodyId - 테이블 body 요소의 ID
 */
export function renderBOMTable(bomData, tableBodyId = 'bom-table-body') {
  const tbody = document.getElementById(tableBodyId);
  if (!tbody) {
    console.error(`Table body element not found: ${tableBodyId}`);
    return;
  }

  // 기존 내용 제거
  tbody.innerHTML = '';

  // 각 행 추가
  bomData.forEach((item) => {
    const row = document.createElement('tr');

    // No 열
    const noCell = document.createElement('td');
    noCell.textContent = item.No || '';
    row.appendChild(noCell);

    // Part Name 열
    const nameCell = document.createElement('td');
    nameCell.textContent = item['Part Name'] || '';
    nameCell.title = item['Part Name'] || ''; // 긴 텍스트용 툴팁
    row.appendChild(nameCell);

    // Quantity 열
    const qtyCell = document.createElement('td');
    qtyCell.textContent = item.Quantity || '';
    row.appendChild(qtyCell);

    tbody.appendChild(row);
  });
}

/**
 * BOM 패널 표시/숨김 토글
 * @param {string} panelId - BOM 패널 요소의 ID (기본값: 'bom-panel')
 */
export function toggleBOMPanel(panelId = 'bom-panel') {
  const panel = document.getElementById(panelId);
  if (!panel) {
    console.error(`BOM panel element not found: ${panelId}`);
    return;
  }

  panel.classList.toggle('hidden');
}

/**
 * BOM 패널 닫기
 * @param {string} panelId - BOM 패널 요소의 ID (기본값: 'bom-panel')
 */
export function closeBOMPanel(panelId = 'bom-panel') {
  const panel = document.getElementById(panelId);
  if (!panel) {
    console.error(`BOM panel element not found: ${panelId}`);
    return;
  }

  panel.classList.add('hidden');
}

/**
 * 사용 예시:
 *
 * // BOM 데이터 로드
 * await loadBOMData('/data/sample_bom.csv');
 *
 * // BOM 패널 토글
 * toggleBOMPanel();
 *
 * // BOM 패널 닫기
 * closeBOMPanel();
 */
