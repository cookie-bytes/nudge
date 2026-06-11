import fs from 'fs';
import path from 'path';

const dirs = [
  'test/fixtures/diagrams/core',
  'test/fixtures/diagrams/refactor'
];

for (const dir of dirs) {
  const absoluteDir = path.resolve(dir);
  if (!fs.existsSync(absoluteDir)) continue;
  
  const files = fs.readdirSync(absoluteDir).filter(f => f.endsWith('.mermaid'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(absoluteDir, file), 'utf8');
    const lines = content.split(/\r?\n/);
    const newLines = ['@startuml'];
    
    // Determine diagram type from the first line
    const firstLine = lines[0].trim();
    if (firstLine.includes('C4Container')) {
      newLines.push('!include <C4/C4_Container>');
    } else {
      newLines.push('!include <C4/C4_Context>');
    }
    
    for (let i = 1; i < lines.length; i++) {
      let line = lines[i];
      let trimmed = line.trim();
      
      // Convert Mermaid rule comment to PlantUML comment
      if (trimmed.startsWith('%%')) {
        line = line.replace(/^\s*%%/, "  '");
      }
      newLines.push(line);
    }
    
    newLines.push('@enduml');
    
    const newFileName = file.replace(/\.mermaid$/, '.puml');
    fs.writeFileSync(path.join(absoluteDir, newFileName), newLines.join('\n'));
    console.log(`Converted ${file} -> ${newFileName}`);
  }
}
