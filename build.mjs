import {readFile,mkdir,writeFile} from 'node:fs/promises';
const constants={HTML:await readFile('src/index.html','utf8'),CSS:await readFile('src/style.css','utf8'),CLIENT:await readFile('src/client.js','utf8'),ICON:(await readFile('src/icon.png')).toString('base64')};
await mkdir('dist/server',{recursive:true});await writeFile('dist/server/index.js',Object.entries(constants).map(([k,v])=>'const '+k+'='+JSON.stringify(v)+';').join('\n')+'\n'+await readFile('src/server.js','utf8'));
