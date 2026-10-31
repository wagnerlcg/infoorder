const express = require('express');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
const FormData = require('form-data');

const app = express();

// Tratamento de erros globais para evitar que o servidor caia
process.on('uncaughtException', (err) => {
    console.error('Erro não tratado:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Rejeição não tratada:', reason);
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Servir os arquivos estáticos da Cozinha (Frontend)
app.use(express.static('public'));

// Configuração de CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

const PORT = process.env.PORT || 3000;
const ai = new GoogleGenAI();

let clientesCozinha = [];

// Rota de Tempo Real (SSE) para a Cozinha
app.get('/api/stream-pedidos', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Libera o proxy do Easypanel

    clientesCozinha.push(res);

    req.on('close', () => {
        clientesCozinha = clientesCozinha.filter(client => client !== res);
    });
});

// Envia ping periódico GLOBAL para manter a conexão aberta (Correção do erro res is not defined)
setInterval(() => {
    clientesCozinha.forEach(client => {
        client.write(': ping\n\n');
    });
}, 25000);

// Função para enviar os pedidos reais para a tela
function enviarParaCozinha(pedido) {
    clientesCozinha.forEach(client => {
        client.write(`data: ${JSON.stringify(pedido)}\n\n`);
    });
}

// Webhook do WhatsApp
app.post('/webhook/whatsapp', async (req, res) => {
    console.log("🔔 [WEBHOOK RECEBIDO] Evento:", req.body?.event, "| Tem Base64?", !!(req.body?.base64 || req.body?.data?.base64 || req.body?.data?.message?.base64));
    try {
        const data = req.body;

        if (data.event === 'messages.upsert') {
            const messageData = data.data;

            // ATENÇÃO: Se o atendente enviar o print usando O MESMO celular que está 
            // conectado no sistema (para um grupo, por exemplo), remova este bloco de bloqueio.
            if (messageData.key && messageData.key.fromMe) {
                return res.status(200).send({ status: 'ignored_own_message' });
            }

            const messageType = messageData.messageType;
            let textoParaProcessar = "";
            let imagemBase64 = null;

            // 1. Extrai o texto (seja uma mensagem normal ou a legenda do print)
            if (messageData.message?.conversation) {
                textoParaProcessar = messageData.message.conversation;
            } else if (messageData.message?.extendedTextMessage?.text) {
                textoParaProcessar = messageData.message.extendedTextMessage.text;
            } else if (messageData.message?.imageMessage?.caption) {
                textoParaProcessar = messageData.message.imageMessage.caption;
            } else if (messageType === 'audioMessage') {
                const audioUrl = messageData.message?.audioMessage?.url || messageData.audioUrl;
                if (audioUrl) textoParaProcessar = await transcreverAudioWhisper(audioUrl);
            }

            // 2. Extrai a imagem do print
            if (messageType === 'imageMessage') {
                // Captura o Base64 enviado pela Evolution API
                imagemBase64 = messageData.base64 || messageData.message?.base64 || data.base64;

                if (!imagemBase64) {
                    console.log("⚠️ Print recebido, mas o Base64 está vazio. Ative o envio de Base64 no webhook da Evolution API.");
                }
            }

            // 3. Se houver texto ou imagem, envia para o Gemini
            if (textoParaProcessar || imagemBase64) {
                console.log(`Analisando envio. Tem legenda/texto? ${!!textoParaProcessar} | Tem print? ${!!imagemBase64}`);
                const pedidoEstruturado = await processarPedidoComIA(textoParaProcessar, imagemBase64);
                console.log("Pedido estruturado:", JSON.stringify(pedidoEstruturado, null, 2));

                enviarParaCozinha(pedidoEstruturado);
            }
        }

        return res.status(200).send({ status: 'success' });
    } catch (error) {
        console.error('Erro ao processar webhook:', error);
        return res.status(500).send({ error: 'Internal Server Error' });
    }
});
// Transcrição de Áudio
async function transcreverAudioWhisper(audioUrl) {
    try {
        const responseAudio = await axios.get(audioUrl, { responseType: 'arraybuffer' });
        const audioBuffer = Buffer.from(responseAudio.data);

        const form = new FormData();
        form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
        form.append('model', 'whisper-1');
        form.append('language', 'pt');

        const responseWhisper = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
            headers: {
                ...form.getHeaders(),
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            }
        });

        return responseWhisper.data.text;
    } catch (error) {
        console.error('Erro no Whisper:', error.message);
        return "";
    }
}

// Processamento com IA (Gemini) com suporte a Imagens (Prints)
async function processarPedidoComIA(textoCliente, imagemBase64 = null, tentativasMaximas = 3) {
    const prompt = `
        Você é um assistente especialista em extrair pedidos de delivery.
        Analise a imagem da conversa (print) de WhatsApp e/ou o texto abaixo.
        Extraia estritamente no formato JSON as seguintes informações do pedido:
        {
          "cliente_nome": "Nome do cliente se mencionado, senão null",
          "itens": [
            {
              "quantidade": 1,
              "produto": "Nome do produto",
              "observacao": "Detalhes como sem cebola, etc ou string vazia"
            }
          ],
          "tipo_pedido": "delivery ou retirada",
          "endereco_entrega": "Endereço completo (Rua, número, bairro, referência) ou null se for retirada",
          "forma_pagamento": "Dinheiro, Pix, Cartão ou null",
          "troco_para": "Valor se precisar de troco, senão null"
        }
    `;

    // Monta o "pacote" de envio misturando texto e imagem
    const parts = [{ text: prompt }];

    if (textoCliente) {
        parts.push({ text: `\nLegenda/Mensagem: "${textoCliente}"` });
    }

    if (imagemBase64) {
        parts.push({
            inlineData: {
                data: imagemBase64,
                mimeType: 'image/jpeg' // O Gemini interpreta tanto jpg quanto png com esse mimeType
            }
        });
    }

    const contentsConfig = [{ role: 'user', parts: parts }];

    for (let tentativa = 1; tentativa <= tentativasMaximas; tentativa++) {
        try {
            const response = await ai.models.generateContent({
                model: 'gemini-3.8-flash',
                contents: contentsConfig, // Envia o pacote multimodal
                config: { responseMimeType: 'application/json' }
            });

            return JSON.parse(response.text);
        } catch (error) {
            console.error(`Erro no Gemini (Tentativa ${tentativa}/${tentativasMaximas}):`, error.message);

            if (tentativa === tentativasMaximas) {
                return { erro: 'Não foi possível estruturar o pedido devido a instabilidade na IA.' };
            }

            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}
// Rota de Health Check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'online', timestamp: new Date() });
});

// Inicialização do Servidor
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});