require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

// Importa fetch (solo si Node.js es < 18.x)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Crea el servidor Express
const app = express();
const upload = multer({ dest: 'uploads/' });

// Inicializa la aplicación de Slack SIN Socket Mode
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Almacena los mensajes enviados para rastrear reacciones
const sentMessages = {};

// Ruta para recibir archivos a través de Slash Command
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send('No se ha enviado ningún archivo.');
    }
    const filePath = req.file.path;
    const data = await readCsvFile(filePath);
    console.log('Datos leídos del CSV:', data);

    for (const row of data) {
      const slackUserId = row['Slack User'];
      const salary = row['Salary'];
      const agentName = row['Name'];
      const faltas = row['Faltas'] || 0;
      const feriadosTrabajados = row['Feriados Trabajados'] || 0;

      if (slackUserId && salary) {
        const message = generateMessage(agentName, salary, faltas, feriadosTrabajados);
        const result = await slackApp.client.chat.postMessage({
          channel: slackUserId,
          text: message,
        });
        console.log(`Mensaje enviado a ${agentName} (ID: ${slackUserId}):`, message);
        sentMessages[result.ts] = { user: slackUserId, name: agentName };
      }
    }

    const channelId = req.body.channel_id;
    await slackApp.client.chat.postMessage({
      channel: channelId,
      text: '¡Archivo procesado con éxito! ✅',
    });

    fs.unlinkSync(filePath);
    res.status(200).send('Archivo procesado con éxito.');
  } catch (error) {
    console.error('Error al procesar el archivo:', error);
    res.status(500).send('Error al procesar el archivo.');
  }
});

function readCsvFile(filePath) {
  return new Promise((resolve, reject) => {
    const data = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => data.push(row))
      .on('end', () => resolve(data))
      .on('error', (error) => reject(error));
  });
}

function generateMessage(name, salary, faltas, feriadosTrabajados) {
  const faltasText = faltas === 1 ? `hubo *${faltas} falta*` : faltas > 1 ? `hubo *${faltas} faltas*` : '*no hubo faltas*';
  const feriadosText = feriadosTrabajados === 1 ? `trabajó en *${feriadosTrabajados} feriado*` : feriadosTrabajados > 1 ? `trabajó en *${feriadosTrabajados} feriados*` : '*no trabajó en ningún feriado*';

  return `
:wave: *¡Buenos días, ${name}!*
Esperamos que todo esté bien. Queremos compartir los detalles de tu salario de este mes.

*Salario a pagar este mes:* US$${salary}

*Instrucciones para la emisión de la factura:*
• La factura debe emitirse hasta el _último día hábil del mes_.
• Al emitir la factura, incluye el tipo de cambio utilizado y el mes de referencia. Ejemplo:
  \`\`\`
  Honorarios <mes> - Asesoría en atención al cliente + tipo de cambio utilizado (US$ 1 = BR$ 5,55)
  \`\`\`

*Detalles adicionales:*
• Faltas: ${faltasText}.
• Feriados trabajados: ${feriadosText}.

*Si no hay pendientes*, puedes emitir la factura con los valores anteriores hasta el último día hábil del mes.

Por favor, confirma que recibiste este mensaje y estás de acuerdo con los valores reaccionando con un ✅ (*check*).

¡Gracias y buen trabajo!
_Atentamente,_  
*Supervisión Corefone BR*
  `;
}

slackApp.event('reaction_added', async ({ event }) => {
  const { reaction, item } = event;
  if (reaction === 'white_check_mark' && sentMessages[item.ts]) {
    const { user: slackUserId, name } = sentMessages[item.ts];
    await slackApp.client.chat.postMessage({
      channel: process.env.CHANNEL_ID,
      text: `El agente ${name} (@${slackUserId}) confirmó la recepción del salario y está de acuerdo con los valores.`,
    });
  }
});

slackApp.event('message', async ({ event, say }) => {
  const { channel, text, user } = event;
  const conversationType = await slackApp.client.conversations.info({ channel });
  if (conversationType.channel.is_im) {
    console.log(`Mensaje recibido de ${user} en DM: ${text}`);
    await say(`¡Hola! Recibí tu mensaje: "${text}". Si necesitas algo, aquí estoy.`);
  }
});

slackApp.event('file_shared', async ({ event }) => {
  try {
    const { file_id, channel_id } = event;
    const fileInfo = await slackApp.client.files.info({ file: file_id });
    if (fileInfo.file.filetype === 'csv') {
      const fileUrl = fileInfo.file.url_private_download;
      const filePath = path.join(__dirname, 'uploads', fileInfo.file.name);
      const response = await fetch(fileUrl, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });
      const arrayBuffer = await response.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
      const data = await readCsvFile(filePath);
      console.log('Datos del CSV:', data);
    }
  } catch (error) {
    console.error('Error al procesar el archivo compartido:', error);
  }
});

app.get('/', (req, res) => res.status(200).send('¡El bot está en ejecución!'));
app.head('/', (req, res) => res.status(200).end());

slackApp.start(process.env.PORT || 3000).then(() => {
  console.log(`⚡️ ¡La aplicación de Slack Bolt está funcionando en el puerto ${process.env.PORT || 3000}!`);
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 ¡El servidor Express está funcionando en el puerto ${process.env.PORT || 3000}!`);
});
