import fs from 'fs';
import { chromium } from 'playwright';
import path from 'path';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // Read SVG content
  const svgContent = fs.readFileSync('test_outputs/search_service_container.svg', 'utf8');
  
  // Read CSS styles from render.html
  const htmlContent = fs.readFileSync('src/render.html', 'utf8');
  const styleMatch = htmlContent.match(/<style>([\s\S]*?)<\/style>/);
  const styles = styleMatch ? styleMatch[1] : '';
  
  // Inject style tag into the SVG content right inside <defs> or at start
  const styledSvg = svgContent.replace('</defs>', `<style>${styles}</style></defs>`);
  
  // Load the styled SVG content
  await page.setContent(styledSvg);
  
  // Set viewport
  await page.setViewportSize({ width: 1540, height: 1144 });
  
  // Capture a screenshot of the region around (1040, 700)
  const clip = { x: 990, y: 650, width: 150, height: 100 };
  
  const destDir = '/Users/admin/.gemini/antigravity-cli/brain/ff6a7a6c-6b25-492f-995e-9324f189f5cb/scratch';
  const destPath = path.join(destDir, 'arrow_close_up_exact.png');
  await page.screenshot({
    path: destPath,
    clip: clip
  });
  
  console.log(`Saved screenshot to ${destPath}`);

  await browser.close();
}

run().catch(console.error);
