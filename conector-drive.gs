/* ApiarIA · CONECTOR DRIVE (Google Apps Script) — OPCIONAL
   1. script.google.com → Nuevo proyecto → pega este archivo
   2. Cambia CLAVE por una contraseña tuya
   3. Implementar → Aplicación web → Ejecutar como: YO → Acceso: CUALQUIER PERSONA
   4. Copia la URL /exec y pégala en ApiarIA → Conectores ＋ */
const CLAVE = "CAMBIA-ESTA-CLAVE";
const CARPETA_ID = ""; // opcional: ID de carpeta de Drive

function doPost(e){
  try{
    const d = JSON.parse(e.postData.contents);
    if(d.clave !== CLAVE) return resp({ok:false,error:"Clave incorrecta"});
    const carpeta = obtenerCarpeta();
    if(d.accion==="listar"){
      const archivos=[]; const it=carpeta.getFiles();
      while(it.hasNext() && archivos.length<100){ const f=it.next(); archivos.push({id:f.getId(),nombre:f.getName()}); }
      return resp({ok:true,archivos:archivos});
    }
    if(d.accion==="leer"){
      const f=DriveApp.getFileById(d.id); const mime=f.getMimeType(); let contenido;
      if(mime===MimeType.GOOGLE_DOCS) contenido=DocumentApp.openById(d.id).getBody().getText();
      else if(mime===MimeType.GOOGLE_SHEETS){ const h=SpreadsheetApp.openById(d.id).getSheets()[0]; contenido=h.getDataRange().getValues().map(r=>r.join("\t")).join("\n"); }
      else contenido=f.getBlob().getDataAsString("UTF-8");
      return resp({ok:true,contenido:contenido.slice(0,100000)});
    }
    if(d.accion==="guardar"){
      const nombre=(d.nombre||"pieza.html").replace(/[\\/:*?"<>|]/g,"-");
      const archivo=carpeta.createFile(nombre,d.contenido,"text/html");
      archivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return resp({ok:true,url:archivo.getUrl(),id:archivo.getId()});
    }
    return resp({ok:false,error:"Acción desconocida"});
  }catch(err){ return resp({ok:false,error:String(err)}); }
}
function doGet(){ return resp({ok:true,mensaje:"Conector ApiarIA activo",carpeta:obtenerCarpeta().getName()}); }
function obtenerCarpeta(){
  if(CARPETA_ID) return DriveApp.getFolderById(CARPETA_ID);
  const it=DriveApp.getFoldersByName("ApiarIA");
  return it.hasNext()?it.next():DriveApp.createFolder("ApiarIA");
}
function resp(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
