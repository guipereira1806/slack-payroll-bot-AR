require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

// Importar fetch (solo si Node.js es < 18.x)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Crear el servidor Express
const app = express();
const upload = multer({ dest: 'uploads/' });

// Inicializar la aplicación de Slack SIN Socket Mode
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Almacenar mensajes enviados para rastrear reacciones
const sentMessages = {};

// Ruta para manejar la carga de archivos vía comando Slash
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send('No se envió ningún archivo.');
    }
    const filePath = req.file.path;
    const data = await readCsvFile(filePath);
    console.log('Datos del CSV:', data);

    for (const row of data) {
      const slackUserId = row['Slack User'];
      const salary = row['Salary'];
      const agentName = row['Name'];
      const faltas = row['Faltas'] || 0;
      const feriadosTrabajados = row['Feriados Trabalhados'] || 0;

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
      text: '¡Hoja de cálculo procesada! ✅',
    });

    fs.unlinkSync(filePath);
    res.status(200).send('¡Hoja de cálculo procesada con éxito!');
  } catch (error) {
    console.error('Error al procesar la hoja de cálculo:', error);
    res.status(500).send('Error al procesar la hoja de cálculo.');
  }
});

// Función para leer un archivo CSV
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

// Función para generar mensaje personalizado
function generateMessage(name, salary, faltas, feriadosTrabajados) {
  const faltasText = faltas == 1 ? `hubo *${faltas} falta*` : faltas > 1 ? `hubo *${faltas} faltas*` : '*no hubo faltas*';
  const feriadosText = feriadosTrabajados == 1 ? `trabajó en *${feriadosTrabajados} feriado*` : feriadosTrabajados > 1 ? `trabajó en *${feriadosTrabajados} feriados*` : '*no trabajó en ningún feriado*';

  return `
:wave: *¡Buenos días, ${name}!*
Esperamos que todo esté bien. Aquí están los detalles de tu salario de este mes.

*Salario a recibir este mes:* US$${salary}

*Instrucciones para emitir la factura:*
• La factura debe emitirse hasta el _último día hábil del mes_.
• Incluye el tipo de cambio utilizado y el mes de referencia. Ejemplo:
  \`\`\`
  Honorarios <mes> - Asesoría en atención al cliente + tipo de cambio utilizado (US$ 1 = BR$ 5,55)
  \`\`\`

*Detalles adicionales:*
• Faltas: ${faltasText}.
• Feriados trabajados: ${feriadosText}.

*Si no hay pendientes*, puedes emitir la factura con los valores anteriores hasta el último día hábil del mes.

Por favor, confirma que recibiste este mensaje y estás de acuerdo con los valores reaccionando con un ✅ (*check*).

¡Gracias y que tengas un excelente día!
_Atentamente,_  
*Supervisión Corefone BR*
`;
}

// Ruta para responder a pings de monitoreo
app.get('/', (req, res) => {
  res.status(200).send('¡El bot está funcionando correctamente! ✅');
});

// Conectar Bolt al servidor Express
slackApp.start(process.env.PORT || 3000).then(() => {
  console.log(`⚡️ La aplicación de Slack Bolt está ejecutándose en el puerto ${process.env.PORT || 3000}!`);
});

// Iniciar servidor Express
app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Servidor Express ejecutándose en el puerto ${process.env.PORT || 3000}!`);
});
