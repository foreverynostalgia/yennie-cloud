import {stripTypeScriptTypes} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const constants={HTML:await readFile('src/index.html','utf8'),PRIVACY:await readFile('src/privacy.html','utf8'),CSS:await readFile('src/style.css','utf8'),CLIENT:await readFile('src/client.js','utf8'),ICON:(await readFile('src/icon.png')).toString('base64')};
const managerFiles = ['index.html', 'bootstrap.js', 'portal-booking.js', 'app.js', 'homework.js', 'qrcode.js', 'integration.js', 'weekly.js', 'videos.js', 'ocr.js', 'yennie-icon.png', 'yennie-app-180.png', 'yennie-app-192.png', 'yennie-app-512.png'];
constants.MANAGER = Object.fromEntries(await Promise.all(managerFiles.map(async name => [
  name, (await readFile('src/manager/' + name)).toString(name.endsWith('.png') ? 'base64' : 'utf8'),
])));
const studentFiles = Object.fromEntries(await Promise.all(['index.html','client.js'].map(async name=>[name,await readFile('src/student/'+name,'utf8')])));
constants.STUDENT = studentFiles;
const portalSource = await readFile('src/student-portal.js','utf8');
const grading = (await Promise.all(['exam-layout','learning-grading'].map(async name=>
  stripTypeScriptTypes((await readFile('src/'+name+'.ts','utf8')).replace(/^export /gm,''))
))).join('\n');
await mkdir('dist/server',{recursive:true});await writeFile('dist/server/index.js',Object.entries(constants).map(([k,v])=>'const '+k+'='+JSON.stringify(v)+';').join('\n')+'\n'+grading+'\n'+portalSource+'\n'+await readFile('src/teacher-auth.js','utf8')+'\n'+await readFile('src/server.js','utf8'));
