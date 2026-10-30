const express = require('express');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
const FormData = require('form-data');

const app = express();

process.on('uncaughtException', (err) => {
    console.error('Erro não tratado:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Rejeição não tratada:', reason);
});

app.use(express.json({ limit: '50mb' }));

// Configuração de CORS para evitar qualquer bloqueio
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

    clientesCozinha.push(res);

    req.on('close', () => {
        clientesCozinha = clientesCozinha.filter(client => client !== res);
    });
});

function enviarParaCozinha(pedido) {
    clientesCozinha.forEach(client => {
        client.write(`data: ${JSON.stringify(pedido)}\n\n`);
    });
}

app.post('/webhook/whatsapp', async (req, res) => {
    try {
        const data = req.body;

        if (data.event === 'messages.upsert') {
            const messageData = data.data;
            
            if (messageData.key && messageData.key.fromMe) {
                return res.status(200).send({ status: 'ignored_own_message' });
            }

            const senderPhone = messageData.key?.remoteJid;
            const messageType = messageData.messageType; 
            let textoParaProcessar = "";

            if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
                textoParaProcessar = messageData.message?.conversation || messageData.message?.extendedTextMessage?.text;
            } else if (messageType === 'audioMessage') {
                const audioUrl = messageData.message?.audioMessage?.url || messageData.audioUrl;
                if (audioUrl) {
                    textoParaProcessar = await transcreverAudioWhisper(audioUrl);
                }
            }

            if (textoParaProcessar) {
                console.log(`Texto para análise: "${textoParaProcessar}"`);
                const pedidoEstruturado = await processarPedidoComIA(textoParaProcessar);
                console.log("Pedido estruturado pela IA:", JSON.stringify(pedidoEstruturado, null, 2));

                enviarParaCozinha(pedidoEstruturado);
            }
        }

        return res.status(200).send({ status: 'success' });
    } catch (error) {
        console.error('Erro ao processar webhook:', error);
        return res.status(500).send({ error: 'Internal Server Error' });
    }
});

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
        console.error('Erro ao transcrever áudio com Whisper:', error.response?.data || error.message);
        return "";
    }
}

async function processarPedidoComIA(textoCliente) {
    try {
        const prompt = `
            Você é um assistente de IA especialista em extrair pedidos de delivery (lanchonete/pizzaria) a partir de mensagens de WhatsApp.
            Analise a mensagem abaixo e extraia as informações estritamente no formato JSON, seguindo este schema:
            {
              "cliente_nome": "Nome do cliente se mencionado, senão null",
              "itens": [
                {
                  "quantidade": 1,
                  "produto": "Nome do produto",
                  "observacao": "Detalhes como sem cebola, ponto, etc. ou string vazia"
                }
              ],
              "tipo_pedido": "delivery ou retirada",
              "endereco_entrega": "Endereço completo se mencionado, senão null",
              "forma_pagamento": "Dinheiro, Pix, Cartão ou null",
              "troco_para": "Valor se precisar de troco, senão null"
            }

            Mensagem do cliente: "${textoCliente}"
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
            }
        });

        return JSON.parse(response.text);
    } catch (error) {
        console.error('Erro ao processar com o Gemini:', error);
        return { erro: 'Não foi possível estruturar o pedido' };
    }
}

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'online', timestamp: new Date() });
});


app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});