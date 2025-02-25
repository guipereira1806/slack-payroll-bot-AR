require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
const fetch = require('node-fetch'); // Importar fetch correctamente

// Configurar Express
const app = express();
const upload = multer({ dest: 'uploads/' });

// Inicializar Slack App
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const sentMessages = {}; // Para rastrear mensajes enviados

// Ruta para verificar que el bot está en ejecución
app.get('/', (req, res) => res.status(200).send('Bot is running!'));
app.head('/', (req, res) => res.status(200).end());

// Función para leer archivos CSV
const readCsvFile = (filePath) => {
  return new Promise((resolve, reject) => {
    const data = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => data.push(row))
      .on('end', () => resolve(data))
      .on('error', (error) => reject(error));
  });
};

// Función para generar el mensaje
const generateMessage = (name, salary, absences, holidaysWorked) => {
  const absencesText = absences > 1 ? `se registraron ${absences} faltas` : absences === 1 ? `se registró ${absences} falta` : 'no se registraron faltas';
  const holidaysText = holidaysWorked > 1 ? `trabajaste ${holidaysWorked} días feriados` : holidaysWorked === 1 ? `trabajaste ${holidaysWorked} día feriado` : 'no trabajaste días feriados';
  return `
:wave: ¡Hola, ${name}!
Esperamos que te encuentres muy bien. Nos comunicamos contigo para compartir los detalles de tu salario correspondiente a este mes.
*Salario a pagar este mes:* US$${salary}
*Detalles adicionales:*
• Faltas: ${absencesText}.
• Días feriados trabajados: ${holidaysText}.
Por favor, confirma con un ✅ si estás de acuerdo.
*Supervisión Corefone AR/LATAM*`;
};

// Ruta para procesar archivos CSV
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).send('No se ha subido ningún archivo.');
  try {
    const data = await readCsvFile(req.file.path);
    for (const row of data) {
      const { 'Slack User': slackUserId, Salary: salary, Name: agentName, Absences: absences = 0, 'Holidays Worked': holidaysWorked = 0 } = row;
      if (slackUserId && salary) {
        const message = generateMessage(agentName, salary, absences, holidaysWorked);
        const result = await slackApp.client.chat.postMessage({ channel: slackUserId, text: message });
        sentMessages[result.ts] = { user: slackUserId, name: agentName };
      }
    }
    await slackApp.client.chat.postMessage({ channel: req.body.channel_id, text: 'Planilla procesada! ✅' });
    fs.unlinkSync(req.file.path);
    res.status(200).send('Planilla procesada exitosamente!');
  } catch (error) {
    console.error('Error al procesar la planilla:', error);
    res.status(500).send('Error al procesar la planilla.');
  }
});

// Monitoreo de reacciones
slackApp.event('reaction_added', async ({ event }) => {
  if (event.reaction === 'white_check_mark' && sentMessages[event.item.ts]) {
    const { user, name } = sentMessages[event.item.ts];
    await slackApp.client.chat.postMessage({
      channel: process.env.CHANNEL_ID,
      text: `Agente ${name} (@${user}) confirmó la recepción del salario.`,
    });
  }
});

// Listener de mensajes en DM
slackApp.event('message', async ({ event, say }) => {
  const { channel, text, user } = event;
  const conversation = await slackApp.client.conversations.info({ channel });
  if (conversation.channel.is_im) {
    console.log(`Mensaje de ${user}: ${text}`);
    await say(`¡Hola! He recibido tu mensaje: "${text}".`);
  }
});

// Iniciar servidores
(async () => {
  await slackApp.start(process.env.PORT || 3000);
  app.listen(process.env.PORT || 3000, () => console.log(`🚀 Servidor activo en puerto ${process.env.PORT || 3000}`));
})();
