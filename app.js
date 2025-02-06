require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

// Importa o fetch (apenas se o Node.js for < 18.x)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Cria a pasta 'uploads' se ela não existir
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Inicializa o app do Slack
const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Inicializa o servidor Express
const app = express();
const upload = multer({ dest: 'uploads/' });

// Armazena as mensagens enviadas para rastrear reações
const sentMessages = {};

// Rota para receber arquivos via Slash Command
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    // Verifica se o corpo da requisição contém o arquivo
    if (!req.file) {
      return res.status(400).send('Nenhum arquivo foi enviado.');
    }

    const filePath = req.file.path;
    const data = await readCsvFile(filePath);

    console.log('Dados lidos do CSV:', data);

    for (const row of data) {
      const slackUserId = row['Slack User']; // Coluna com o ID do usuário no Slack
      const salary = row['Salary']; // Coluna com o salário
      const agentName = row['Name']; // Coluna com o nome do agente
      const faltas = row['Faltas'] || 0; // Coluna com o número de faltas
      const feriadosTrabalhados = row['Feriados Trabalhados'] || 0; // Coluna com feriados trabalhados

      if (slackUserId && salary) {
        // Envia DM para o agente
        const message = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
        const result = await slackApp.client.chat.postMessage({
          channel: slackUserId, // Usa o ID do usuário diretamente
          text: message,
        });

        console.log(`Mensagem enviada para ${agentName} (ID: ${slackUserId}):`, message);

        // Armazena o ID da mensagem enviada para rastrear reações
        sentMessages[result.ts] = {
          user: slackUserId,
          name: agentName,
        };
      }
    }

    // Responde ao canal privado com um check
    const channelId = req.body.channel_id;
    await slackApp.client.chat.postMessage({
      channel: channelId,
      text: 'Planilha processada! ✅',
    });

    // Remove o arquivo após o processamento
    fs.unlinkSync(filePath);
    res.status(200).send('Planilha processada com sucesso!');
  } catch (error) {
    console.error('Erro ao processar a planilha:', error);
    res.status(500).send('Erro ao processar a planilha.');
  }
});

// Função para ler o arquivo CSV
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

// Função para gerar a mensagem personalizada
function generateMessage(name, salary, faltas, feriadosTrabalhados) {
  const faltasText = faltas === 1 
    ? `houve *${faltas} falta*` 
    : faltas > 1 
    ? `houve *${faltas} faltas*` 
    : '*não houve faltas*';

  const feriadosText = feriadosTrabalhados === 1 
    ? `trabalhou em *${feriadosTrabalhados} feriado*` 
    : feriadosTrabalhados > 1 
    ? `trabalhou em *${feriadosTrabalhados} feriados*` 
    : '*não trabalhou em nenhum feriado*';

  return `
:wave: *Bom dia, ${name}!*

Esperamos que esteja tudo bem. Passamos aqui para compartilhar os detalhes do seu salário referente a este mês.


*Valor do salário a ser pago neste mês:* US$${salary}


*Instruções para emissão da nota:*
• A nota deve ser emitida até o _penúltimo dia útil do mês_.
• Ao emitir a nota, inclua o valor do câmbio utilizado e o mês de referência. Segue um exemplo:
  \`\`\`
  Honorários <mês> - Asesoramiento de atenção al cliente + cambio utilizado (US$ 1 = BR$ 5,55)
  \`\`\`


*Detalhes adicionais:*
• Faltas: ${faltasText}.
• Feriados trabalhados: ${feriadosText}.


*Caso não haja pendências*, você pode emitir a nota com os valores acima até o penúltimo dia útil do mês.


Por favor, confirme que recebeu esta mensagem e concorda com os valores acima reagindo com um ✅ (*check*).


Agradecemos sua atenção e desejamos um ótimo trabalho!

_Atenciosamente,_  
*Supervisão Corefone BR*
`;
}

// Monitora reações às mensagens
slackApp.event('reaction_added', async ({ event }) => {
  const { reaction, item, user } = event;

  // Verifica se a reação é um ✅ e se a mensagem está no canal correto
  if (reaction === 'white_check_mark' && sentMessages[item.ts]) {
    const { user: slackUserId, name } = sentMessages[item.ts];
    await slackApp.client.chat.postMessage({
      channel: process.env.CHANNEL_ID,
      text: `Agente ${name} (@${slackUserId}) confirmou o recebimento do salário e está de acordo com os valores.`,
    });
  }
});

// Listener para mensagens em DMs
slackApp.event('message', async ({ event, say }) => {
  const { channel, text, user } = event;

  // Verifica se a mensagem foi enviada em uma DM
  const conversationType = await slackApp.client.conversations.info({ channel });
  if (conversationType.channel.is_im) {
    console.log(`Mensagem recebida de ${user} na DM: ${text}`);
    await say(`Olá! Recebi sua mensagem: "${text}". Se precisar de algo, estou aqui!`);
  }
});

// Listener para uploads de arquivos
slackApp.event('file_shared', async ({ event }) => {
  try {
    const { file_id, channel_id } = event;

    // Obtém informações sobre o arquivo
    const fileInfo = await slackApp.client.files.info({
      file: file_id,
    });

    console.log('Arquivo compartilhado:', fileInfo.file);

    // Verifica se o arquivo é um CSV
    if (fileInfo.file.filetype === 'csv') {
      // Baixa o arquivo CSV
      const fileUrl = fileInfo.file.url_private_download;
      const filePath = path.join(uploadDir, fileInfo.file.name);

      const response = await fetch(fileUrl, {
        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        },
      });

      const arrayBuffer = await response.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(arrayBuffer));

      console.log(`Arquivo baixado: ${filePath}`);

      // Lê o conteúdo do arquivo CSV
      const data = await readCsvFile(filePath);

      console.log('Dados lidos do CSV:', data);

      // Processa os dados do CSV
      for (const row of data) {
        const slackUserId = row['Slack User']; // Coluna com o ID do usuário no Slack
        const salary = row['Salary']; // Coluna com o salário
        const agentName = row['Name']; // Coluna com o nome do agente
        const faltas = row['Faltas'] || 0; // Coluna com o número de faltas
        const feriadosTrabalhados = row['Feriados Trabalhados'] || 0; // Coluna com feriados trabalhados

        if (slackUserId && salary) {
          // Envia DM para o agente
          const message = generateMessage(agentName, salary, faltas, feriadosTrabalhados);
          const result = await slackApp.client.chat.postMessage({
            channel: slackUserId, // Usa o ID do usuário diretamente
            text: message,
          });

          console.log(`Mensagem enviada para ${agentName} (ID: ${slackUserId}):`, message);

          // Armazena o ID da mensagem enviada para rastrear reações
          sentMessages[result.ts] = {
            user: slackUserId,
            name: agentName,
          };
        }
      }

      // Responde ao canal privado com um check
      await slackApp.client.chat.postMessage({
        channel: channel_id,
        text: 'Planilha processada! ✅',
      });

      // Remove o arquivo após o processamento
      fs.unlinkSync(filePath);
    } else {
      console.log('O arquivo compartilhado não é um CSV.');
    }
  } catch (error) {
    console.error('Erro ao processar o arquivo compartilhado:', error);
  }
});

// Inicia o servidor Express e o Slack Bolt
(async () => {
  await slackApp.start(process.env.PORT || 3000);
  console.log(`⚡️ Slack Bolt app is running on port ${process.env.PORT || 3000}!`);
})();