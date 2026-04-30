const express = require('express');
const cors = require('cors');
const path = require('path');
const { Duffel } = require('@duffel/api');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin'); // ☁️ Importa Firebase

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 🔥 CONFIGURAÇÃO DO FIREBASE
// ==========================================
const serviceAccount = require("./firebase-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore(); // 🏦 Conexão com o banco de dados
const radaresColl = db.collection('radares'); // 📁 Nossa coleção principal

// ==========================================
// 🔐 TOKENS DE API
// ==========================================
const duffel = new Duffel({ token: 'duffel_test_nALMdAdvl5V37UC6y1Hm3-kjzqQ9zfjWDrF3GUd_-5R' });
const stripe = Stripe('sk_test_51TOq1MJ2bakKpaKf3M3IXIVyeOTHWxQcV0lC0yGiLtxU5XbSXa1Q0Mm0ZJRVNiFcbFPBnebEp5AXJcAVHw1LTfxy00Hpd3NtXj'); 

app.use(cors());
app.use(express.json());

// ==========================================
// 📧 CONFIGURAÇÃO DE E-MAIL
// ==========================================
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'jrcollacio@gmail.com',
        pass: 'pbfwmugcluxexhqm' 
    }
});

const enviarEmailConfirmacao = async (emailCliente, nome, origem, destino, pnr) => {
    const mailOptions = {
        from: '"Go Driver - Viagens" <jrcollacio@gmail.com>',
        to: emailCliente,
        subject: `✈️ Sua passagem foi emitida! Localizador: ${pnr}`,
        html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 600px; margin: auto; border: 1px solid #ddd; border-radius: 10px;">
                <h2 style="color: #4A00E0; text-align: center;">Viagem Confirmada! 🎉</h2>
                <p>Olá, <strong>${nome}</strong>!</p>
                <p>O seu pagamento foi aprovado pelo Go Driver e a sua passagem está garantida.</p>
                <div style="background-color: #f4f6f9; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 5px solid #4A00E0;">
                    <p>🛫 <strong>Origem:</strong> ${origem} | 🛬 <strong>Destino:</strong> ${destino}</p>
                    <p style="font-size: 18px; margin-top: 15px;">🎟️ <strong>Localizador (PNR):</strong> <span style="color: #4A00E0; font-weight: bold; font-size: 22px;">${pnr}</span></p>
                </div>
                <p style="text-align: center; color: #888; font-size: 12px;">Boa viagem!<br><em>Equipe Go Driver</em></p>
            </div>
        `
    };
    await transporter.sendMail(mailOptions);
};

// ==========================================
// 📡 ROTAS DE RADARES (FIREBASE)
// ==========================================

app.get('/api/radares', async (req, res) => {
    try {
        const userId = req.query.userId;
        let snapshot;

        if (userId) {
            snapshot = await radaresColl.where('userId', '==', userId).get();
        } else {
            snapshot = await radaresColl.get();
        }

        const lista = snapshot.docs.map(doc => ({ id_db: doc.id, ...doc.data() }));
        res.status(200).json(lista);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/radares', async (req, res) => {
    try {
        const novoRadar = { 
            id: Date.now().toString(), 
            status: 'buscando', 
            notificado: false, 
            criadoEm: admin.firestore.FieldValue.serverTimestamp(),
            ...req.body 
        };
        const docRef = await radaresColl.add(novoRadar);
        res.status(201).json({ id_db: docRef.id, ...novoRadar });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/radares/:id/notificado', async (req, res) => {
    try {
        const snapshot = await radaresColl.where('id', '==', req.params.id).get();
        if (!snapshot.empty) {
            await snapshot.docs[0].ref.update({ notificado: true });
        }
        res.sendStatus(200);
    } catch (e) { res.status(500).send(e.message); }
});

app.delete('/api/radares/:id', async (req, res) => {
    try {
        const snapshot = await radaresColl.where('id', '==', req.params.id).get();
        if (!snapshot.empty) {
            await snapshot.docs[0].ref.delete();
        }
        res.status(200).json({ mensagem: 'Radar excluído.' });
    } catch (e) { res.status(500).send(e.message); }
});

// ==========================================
// 💳 ROTA DE PAGAMENTO STRIPE - GO DRIVER
// ==========================================
app.post('/api/pagamento/intencao', async (req, res) => {
  try {
    const { valor, moeda } = req.body;

    if (!valor || !moeda) {
      return res.status(400).json({ erro: "Valor e moeda são obrigatórios." });
    }

    const valorEmCentimos = Math.round(parseFloat(valor) * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: valorEmCentimos,
      currency: moeda.toLowerCase(),
      automatic_payment_methods: { enabled: true },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
    
  } catch (error) {
    console.error("Erro ao gerar pagamento no Stripe:", error);
    res.status(500).json({ erro: "Falha ao processar pagamento." });
  }
});

// ==========================================
// 🎫 ROTA DE EMISSÃO DA PASSAGEM
// ==========================================
app.post('/api/radares/:id/emitir', async (req, res) => {
    const { nome, sobrenome, dataNascimento, genero, email, telefone } = req.body;
    try {
        console.log(`\n🎫 [EMISSÃO] Iniciando processo Go Driver para ID: ${req.params.id}`);
        
        const snapshot = await radaresColl.where('id', '==', req.params.id).get();
        if (snapshot.empty) {
            return res.status(404).json({ erro: 'Radar não encontrado.' });
        }
        
        const radarData = snapshot.docs[0].data();

        const order = await duffel.orders.create({
            type: 'hold', 
            selected_offers: [radarData.offerId],
            passengers: [{
                id: radarData.passengerId, 
                given_name: nome, 
                family_name: sobrenome,
                born_on: dataNascimento, 
                title: genero === 'M' ? 'mr' : 'ms',
                gender: genero === 'M' ? 'm' : 'f', 
                email: email, 
                phone_number: telefone
            }]
        });

        const pnr = order.data.booking_reference;
        await snapshot.docs[0].ref.update({ status: 'emitido', localizador: pnr });
        await enviarEmailConfirmacao(email, nome, radarData.origem, radarData.destino, pnr);

        console.log(`  ✅ SUCESSO! Localizador Go Driver gerado: ${pnr}`);
        res.status(200).json({ sucesso: true, localizador: pnr });

    } catch (error) {
        console.error(`❌ ERRO NA DUFFEL:`, JSON.stringify(error.errors || error.message, null, 2));
        res.status(500).json({ erro: 'Falha na emissão.', detalhes: error.message });
    }
});

// ==========================================
// 🤖 ROBÔ DE VARREDURA - GO DRIVER
// ==========================================
const gerarDatasDeBusca = (dias = 180) => {
    const datas = [];
    for (let i = 1; i <= dias; i++) {
        const d = new Date(); d.setDate(d.getDate() + i);
        datas.push(d.toISOString().split('T')[0]); 
    }
    return datas;
};

const executarBusca = async () => {
    const snapshot = await radaresColl.where('status', '==', 'buscando').get();
    if (snapshot.empty) return console.log("☁️ [Go Driver] Sem radares ativos para buscar.");

    console.log(`\n🔄 Varredura em ${snapshot.size} radares ativos...`);

    for (let doc of snapshot.docs) {
        let radar = doc.data();
        console.log(`\n🔎 [ROBÔ] Analisando radar: ${radar.origem} ➔ ${radar.destino}`);
        
        const precoAlvo = parseFloat(radar.preco.toString().replace(',', '.'));
        console.log(`  🎯 Alvo do cliente: Abaixo de ${radar.simboloMoeda || ''} ${precoAlvo}`);

        let datasParaTestar = radar.data === 'Qualquer Data' 
            ? gerarDatasDeBusca(180).sort(() => 0.5 - Math.random()).slice(0, 2)
            : [radar.data.split('/').reverse().join('-')];

        for (let dataF of datasParaTestar) {
            console.log(`  ⏳ Testando a data: ${dataF}...`);
            try {
                const offerRequest = await duffel.offerRequests.create({
                    slices: [{ origin: radar.origem, destination: radar.destino, departure_date: dataF }],
                    passengers: [{ type: 'adult' }], cabin_class: 'economy', return_offers: true
                });

                if (offerRequest.data.offers?.length > 0) {
                    const melhor = offerRequest.data.offers.sort((a, b) => parseFloat(a.total_amount) - parseFloat(b.total_amount))[0];
                    const precoFinal = parseFloat(melhor.total_amount) + 50;

                    console.log(`  💸 Menor preço achado na Duffel: ${precoFinal}`);

                    if (precoFinal <= precoAlvo) {
                        
                        // 🌟 EXTRAINDO OS DADOS PARA O APP FLUTTER
                        const companhiaAerea = melhor.owner.name;
                        const dataPartidaCrua = melhor.slices[0].segments[0].departing_at;
                        // Formata a hora para HH:MM
                        const dataObj = new Date(dataPartidaCrua);
                        const horarioPartida = dataObj.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
                        // Gera um link inteligente para check-in
                        const linkCompanhia = `https://www.google.com/search?q=check-in+online+${companhiaAerea.replace(/ /g, '+')}`;

                        await doc.ref.update({
                            status: 'encontrado',
                            precoEncontrado: precoFinal,
                            dataVoo: dataF.split('-').reverse().join('/'),
                            horario: horarioPartida,
                            companhia: companhiaAerea,
                            linkOriginal: linkCompanhia,
                            offerId: melhor.id,
                            passengerId: offerRequest.data.passengers[0].id
                        });
                        console.log(`  🚨 BINGO! Dados salvos (Companhia: ${companhiaAerea}, Hora: ${horarioPartida})`);

                        if (radar.fcmToken) {
                            try {
                                await admin.messaging().send({
                                    token: radar.fcmToken,
                                    notification: {
                                        title: '✈️ Go Driver: Voo Encontrado!',
                                        body: `Passagem de ${radar.origem} para ${radar.destino} por apenas ${radar.simboloMoeda || ''} ${precoFinal}!`
                                    }
                                });
                                console.log(`  📲 Push Notification enviado!`);
                            } catch (pushErr) {
                                console.error(`  ⚠️ Erro Push:`, pushErr.message);
                            }
                        }
                        break; 
                    } else {
                        console.log(`  ❌ Preço alto. O robô vai continuar depois.`);
                    }
                } else {
                    console.log(`  📭 A Duffel não encontrou NENHUM voo para esta data.`);
                }
            } catch (e) {
                console.error(`  ⚠️ ERRO NA DUFFEL:`, e.message);
            }
            await new Promise(r => setTimeout(r, 2000)); 
        }
    }
};

// ==========================================
// 🚀 INICIALIZAÇÃO E TEMPORIZADOR
// ==========================================
const iniciarRobo = () => {
    console.log("\n🤖 Robô Go Driver ONLINE com Firebase!");
    executarBusca();
    // O robô vai rodar exatamente a cada 1 minuto (60.000 ms)
    setInterval(executarBusca, 60000);
};

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Go Driver na nuvem (Porta ${PORT})`);
    iniciarRobo();
});