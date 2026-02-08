/**
 * 아이콘 로더 유틸리티
 *
 * SVG 또는 이미지 파일 아이콘을 동적으로 로드하고 교체할 수 있는 헬퍼 함수들
 */

/**
 * SVG 파일을 로드하여 버튼에 삽입
 * @param {string} buttonId - 버튼 요소의 ID
 * @param {string} iconPath - SVG 파일 경로 (예: '/icons/icon-open.svg')
 * @param {number} size - 아이콘 크기 (기본값: 20)
 */
export async function loadSvgIcon(buttonId, iconPath, size = 20) {
  try {
    const button = document.getElementById(buttonId);
    if (!button) {
      console.warn(`Button with id "${buttonId}" not found`);
      return;
    }

    const response = await fetch(iconPath);
    if (!response.ok) {
      throw new Error(`Failed to load icon: ${iconPath}`);
    }

    const svgText = await response.text();

    // 기존 SVG 제거
    const existingSvg = button.querySelector('svg');
    if (existingSvg) {
      existingSvg.remove();
    }

    // 임시 div에 SVG 텍스트 파싱
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = svgText;
    const svgElement = tempDiv.querySelector('svg');

    if (svgElement) {
      // 크기 설정
      svgElement.setAttribute('width', size);
      svgElement.setAttribute('height', size);

      // 버튼에 추가
      button.appendChild(svgElement);
      console.log(`Icon loaded successfully: ${iconPath}`);
    } else {
      throw new Error('Invalid SVG content');
    }
  } catch (error) {
    console.error(`Error loading SVG icon for ${buttonId}:`, error);
  }
}

/**
 * 이미지 파일을 로드하여 버튼에 삽입
 * @param {string} buttonId - 버튼 요소의 ID
 * @param {string} imagePath - 이미지 파일 경로
 * @param {number} size - 아이콘 크기 (기본값: 20)
 */
export function loadImageIcon(buttonId, imagePath, size = 20) {
  const button = document.getElementById(buttonId);
  if (!button) {
    console.warn(`Button with id "${buttonId}" not found`);
    return;
  }

  // 기존 아이콘 제거
  const existingIcon = button.querySelector('svg, img');
  if (existingIcon) {
    existingIcon.remove();
  }

  // 새 이미지 생성
  const img = document.createElement('img');
  img.src = imagePath;
  img.alt = 'Icon';
  img.className = 'icon-img';
  img.style.width = `${size}px`;
  img.style.height = `${size}px`;

  button.appendChild(img);
  console.log(`Image icon loaded successfully: ${imagePath}`);
}

/**
 * 여러 아이콘을 한 번에 로드
 * @param {Array<{buttonId: string, iconPath: string, type: 'svg'|'image', size?: number}>} icons
 */
export async function loadMultipleIcons(icons) {
  const promises = icons.map(({ buttonId, iconPath, type, size }) => {
    if (type === 'svg') {
      return loadSvgIcon(buttonId, iconPath, size);
    } else if (type === 'image') {
      return loadImageIcon(buttonId, iconPath, size);
    }
  });

  await Promise.all(promises);
  console.log('All icons loaded');
}

/**
 * 사용 예시:
 *
 * // 단일 SVG 아이콘 로드
 * loadSvgIcon('btn-bottom-open', '/icons/icon-open.svg');
 *
 * // 단일 이미지 아이콘 로드
 * loadImageIcon('btn-bottom-snapshot', '/icons/icon-snapshot.png');
 *
 * // 여러 아이콘 한 번에 로드
 * loadMultipleIcons([
 *   { buttonId: 'btn-bottom-open', iconPath: '/icons/icon-open.svg', type: 'svg' },
 *   { buttonId: 'btn-bottom-snapshot', iconPath: '/icons/icon-snapshot.png', type: 'image' },
 *   { buttonId: 'btn-bottom-measure', iconPath: '/icons/icon-measure.svg', type: 'svg', size: 24 }
 * ]);
 */
