import {stripTypeScriptTypes} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
const constants={HTML:await readFile('src/index.html','utf8'),PRIVACY:await readFile('src/privacy.html','utf8'),CSS:await readFile('src/style.css','utf8'),CLIENT:await readFile('src/client.js','utf8'),ICON:(await readFile('src/icon.png')).toString('base64')};
// The landing page ("/") ships its markup in index.html; the signed-in app shell drops it.
constants.APP_HTML=constants.HTML.replace(/<div class="lp">[\s\S]*<\/div><\/main>/,'<p>안전한 클라우드 공간을 불러오는 중입니다.</p></main>');
if(constants.APP_HTML===constants.HTML)throw new Error('landing markup not found in index.html');
const landingFiles=['Pretendard-Regular.subset.woff2','Pretendard-SemiBold.subset.woff2','Pretendard-Bold.subset.woff2','Pretendard-LICENSE.txt','app-dashboard.webp','app-dashboard-1280.webp','logo-96.png'];
constants.LANDING=Object.fromEntries(await Promise.all(landingFiles.map(async n=>[n,(await readFile('src/landing/'+n)).toString('base64')])));
const managerFiles = ['index.html', 'bootstrap.js', 'store-codec.js', 'portal-booking.js', 'app.js', 'homework.js', 'qrcode.js', 'integration.js', 'weekly.js', 'videos.js', 'ocr.js', 'yennie-icon.png', 'yennie-app-180.png', 'yennie-app-192.png', 'yennie-app-512.png'];
constants.MANAGER = Object.fromEntries(await Promise.all(managerFiles.map(async name => [
  name, (await readFile(name === 'store-codec.js' ? 'src/store-codec.js' : 'src/manager/' + name)).toString(name.endsWith('.png') ? 'base64' : 'utf8'),
])));
const studentFiles = Object.fromEntries(await Promise.all(['index.html','client.js'].map(async name=>[name,await readFile('src/student/'+name,'utf8')])));
constants.STUDENT = studentFiles;
const portalSource = await readFile('src/store-codec.js','utf8') + '\n' + await readFile('src/store.js','utf8') + '\n' + await readFile('src/account.js','utf8') + '\n' + await readFile('src/ops.js','utf8') + '\n' + await readFile('src/teacher-code.js','utf8') + '\n' + await readFile('src/student-portal.js','utf8');
const grading = (await Promise.all(['exam-layout','learning-grading'].map(async name=>
  stripTypeScriptTypes((await readFile('src/'+name+'.ts','utf8')).replace(/^export /gm,''))
))).join('\n');
await mkdir('dist/server',{recursive:true});await writeFile('dist/server/index.js',Object.entries(constants).map(([k,v])=>'const '+k+'='+JSON.stringify(v)+';').join('\n')+'\n'+grading+'\n'+portalSource+'\n'+await readFile('src/teacher-auth.js','utf8')+'\n'+await readFile('src/server.js','utf8'));
