require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

// Import fetch (only if Node.js version is < 18.x)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Create the Express server
const app = express();
const upload = multer({ dest: 'uploads/' });

// Initialize the Slack app WITHOUT Socket Mode
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Store sent messages to track reactions
const sentMessages = {};

// Rota GET para responder aos pings do UptimeRobot
app.get('/', (req, res) => {
  res.status(200).send('Bot is running!');
});

// Rota HEAD para evitar erros de requisições não tratadas
app.head('/', (req, res) => {
  res.status(200).end();
});

// Route to receive files via Slash Command
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    // Check if the request body contains a file
    if (!req.file) {
      return res.status(400).send('No se ha subido ningún archivo.');
    }
    const filePath = req.file.path;
    const data = await readCsvFile(filePath);
    console.log('Datos del CSV leídos:', data);

    for (const row of data) {
      const slackUserId = row['Slack User']; // Columna con el ID de usuario en Slack
      const salary = row['Salary']; // Columna con el salario
      const agentName = row['Name']; // Columna con el nombre del agente
      const absences = row['Absences'] || 0; // Columna con el número de faltas
      const holidaysWorked = row['Holidays Worked'] || 0; // Columna con días feriados trabajados

      if (slackUserId && salary) {
        // Enviar mensaje directo al agente
        const message = generateMessage(agentName, salary, absences, holidaysWorked);
        const result = await slackApp.client.chat.postMessage({
          channel: slackUserId, // Usa el ID del usuario directamente
          text: message,
        });
        console.log(`Mensaje enviado a ${agentName} (ID: ${slackUserId}):`, message);

        // Almacena el ID del mensaje enviado para rastrear reacciones
        sentMessages[result.ts] = {
          user: slackUserId,
          name: agentName,
        };
      }
    }

    // Responde al canal privado con un checkmark
    const channelId = req.body.channel_id;
    await slackApp.client.chat.postMessage({
      channel: channelId,
      text: 'Planilla procesada! ✅',
    });

    // Elimina el archivo después de procesarlo
    fs.unlinkSync(filePath);
    res.status(200).send('Planilla procesada exitosamente!');
  } catch (error) {
    console.error('Error al procesar la planilla:', error);
    res.status(500).send('Error al procesar la planilla.');
  }
});

// Function to read the CSV file
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

// Function to generate the personalized message in Spanish
function generateMessage(name, salary, absences, holidaysWorked) {
  const absencesText = absences === 1
    ? `se registró ${absences} falta`
    : absences > 1
    ? `se registraron ${absences} faltas`
    : 'no se registraron faltas';
  const holidaysText = holidaysWorked === 1
    ? `trabajaste ${holidaysWorked} día feriado`
    : holidaysWorked > 1
    ? `trabajaste ${holidaysWorked} días feriados`
    : 'no trabajaste días feriados';

  return `
:wave: ¡Buenos días, ${name}!
Esperamos que te encuentres muy bien. Nos comunicamos contigo para compartir los detalles de tu salario correspondiente a este mes.
*Salario a pagar este mes:* US$${salary}
*Instrucciones para emitir la factura:*
• La factura debe ser emitida antes del _penúltimo día hábil del mes_.
• Al emitirla, incluye el tipo de cambio utilizado y el mes de referencia. Aquí tienes un ejemplo:
\`\`\`
Servicios <mes> - Atención al cliente + tipo de cambio aplicado (US$ 1 = ARS$ 950)
\`\`\`
*Detalles adicionales:*
• Faltas: ${absencesText}.
• Días feriados trabajados: ${holidaysText}.
*Si no hay observaciones pendientes*, puedes emitir la factura con los valores mencionados antes del penúltimo día hábil del mes.
Por favor, confirma que has recibido este mensaje y estás de acuerdo con los valores reaccionando con un ✅ (*marca de verificación*).
Gracias por tu atención y te deseamos un excelente día.
_Atentamente,_  
*Supervisión Corefone AR*
`;
}

// Monitor reactions to messages
slackApp.event('reaction_added', async ({ event }) => {
  const { reaction, item, user } = event;

  // Check if the reaction is a ✅ and if the message is correct
  if (reaction === 'white_check_mark' && sentMessages[item.ts]) {
    const { user: slackUserId, name } = sentMessages[item.ts];
    await slackApp.client.chat.postMessage({
      channel: process.env.CHANNEL_ID,
      text: `Agente ${name} (@${slackUserId}) ha confirmado la recepción del salario y está de acuerdo con los valores.`,
    });
  }
});

// Listener for messages in DMs
slackApp.event('message', async ({ event, say }) => {
  const { channel, text, user } = event;

  // Check if the message was sent in a DM
  const conversationType = await slackApp.client.conversations.info({ channel });
  if (conversationType.channel.is_im) {
    console.log(`Mensaje recibido de ${user} en DM: ${text}`);
    await say(`¡Hola! He recibido tu mensaje: "${text}". Si necesitas algo, ¡estoy aquí!`);
  }
});

// Listener for file uploads
slackApp.event('file_shared', async ({ event }) => {
  try {
    const { file_id, channel_id } = event;

    // Get file information
    const fileInfo = await slackApp.client.files.info({
      file: file_id,
    });
    console.log('Archivo compartido:', fileInfo.file);

    // Check if the file is a CSV
    if (fileInfo.file.filetype === 'csv') {
      // Download the CSV file
      const fileUrl = fileInfo.file.url_private_download;
      const filePath = path.join(__dirname, 'uploads', fileInfo.file.name);
      const response = await fetch(fileUrl, {
        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        },
      });
      const arrayBuffer = await response.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
      console.log(`Archivo descargado: ${filePath}`);

      // Read the CSV file content
      const data = await readCsvFile(filePath);
      console.log('Datos del CSV leídos:', data);

      // Process the CSV data
      for (const row of data) {
        const slackUserId = row['Slack User']; // Columna con el ID de usuario en Slack
        const salary = row['Salary']; // Columna con el salario
        const agentName = row['Name']; // Columna con el nombre del agente
        const absences = row['Absences'] || 0; // Columna con el número de faltas
        const holidaysWorked = row['Holidays Worked'] || 0; // Columna con días feriados trabajados

        if (slackUserId && salary) {
          // Enviar mensaje directo al agente
          const message = generateMessage(agentName, salary, absences, holidaysWorked);
          const result = await slackApp.client.chat.postMessage({
            channel: slackUserId, // Usa el ID del usuario directamente
            text: message,
          });
          console.log(`Mensaje enviado a ${agentName} (ID: ${slackUserId}):`, message);

          // Almacena el ID del mensaje enviado para rastrear reacciones
          sentMessages[result.ts] = {
            user: slackUserId,
            name: agentName,
          };
        }
      }

      // Responde al canal privado con un checkmark
      await slackApp.client.chat.postMessage({
        channel: channel_id,
        text: 'Planilla procesada! ✅',
      });

      // Elimina el archivo después de procesarlo
      fs.unlinkSync(filePath);
    } else {
      console.log('El archivo compartido no es un CSV.');
    }
  } catch (error) {
    console.error('Error al procesar el archivo compartido:', error);
  }
});

// Rota de fallback para garantir que o servidor responda à raiz
app.use((req, res) => {
  res.status(200).send('Bot is running!');
});

// Connect Bolt to the Express server
slackApp.start(process.env.PORT || 3000).then(() => {
  console.log(`⚡️ Slack Bolt app is running on port ${process.env.PORT || 3000}!`);
});

// Start the Express server
app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Express server is running on port ${process.env.PORT || 3000}!`);
});