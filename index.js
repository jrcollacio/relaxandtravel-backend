const express = require('express');
const cors = require('cors');
const path = require('path');
const { Duffel } = require('@duffel/api');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin'); 
const https = require('https'); 
const axios = require('axios'); 

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 🔥 CONFIGURAÇÃO DO FIREBASE
// ==========================================
const serviceAccount = require("./firebase-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const radaresColl = db.collection('radares');

// ==========================================
// 🔐 TOKENS DE API
// ==========================================
const duffel = new Duffel({ token: 'duffel_test_nALMdAdvl5V37UC6y1Hm3-kjzqQ9zfjWDrF3GUd_-5R' });
const stripe = Stripe('sk_test_51TOq1MJ2bakKpaKf3M3IXIVyeOTHWxQcV0lC0yGiLtxU5XbSXa1Q0Mm0ZJRVNiFcbFPBnebEp5AXJcAVHw1LTfxy00Hpd3NtXj'); 
const rapidApiKey = '363302cf2dmsha9976e6d3751a77p1e39fbjsn6287653bf4fa'; 

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
                <p>O seu pagamento foi aprovado pelo Go Driver e a sua reserva está garantida.</p>
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
// 💱 MOTOR DE CONVERSÃO DE MOEDAS (CÂMBIO)
// ==========================================
const obterTaxaDeCambio = (moedaOrigem, moedaDestino) => {
    return new Promise((resolve) => {
        if (moedaOrigem === moedaDestino) {
            return resolve(1);
        }
        
        https.get(`https://api.exchangerate-api.com/v4/latest/${moedaOrigem}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const taxa = json.rates[moedaDestino];
                    resolve(taxa ? taxa : getTaxaFallback(moedaOrigem, moedaDestino));
                } catch (e) {
                    resolve(getTaxaFallback(moedaOrigem, moedaDestino));
                }
            });
        }).on('error', () => resolve(getTaxaFallback(moedaOrigem, moedaDestino)));
    });
};

const getTaxaFallback = (de, para) => {
    const taxas = {
        'EUR_BRL': 5.45, 'USD_BRL': 5.00, 'GBP_BRL': 6.35,
        'BRL_EUR': 0.18, 'BRL_USD': 0.20, 'EUR_USD': 1.08, 'USD_EUR': 0.92
    };
    return taxas[`${de}_${para}`] || 1;
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
    } catch (e) { 
        res.status(500).send(e.message); 
    }
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

        // 🔥 GATILHO INSTANTÂNEO: Acorda o Cérebro no exato segundo em que o radar é criado!
        console.log(`\n⚡ NOVO RADAR DETETADO! A forçar pesquisa imediata...`);
        executarBusca();

    } catch (e) { 
        res.status(500).send(e.message); 
    }
});

app.post('/api/radares/:id/notificado', async (req, res) => {
    try {
        const snapshot = await radaresColl.where('id', '==', req.params.id).get();
        if (!snapshot.empty) {
            await snapshot.docs[0].ref.update({ notificado: true });
        }
        res.sendStatus(200);
    } catch (e) { 
        res.status(500).send(e.message); 
    }
});

app.delete('/api/radares/:id', async (req, res) => {
    try {
        const snapshot = await radaresColl.where('id', '==', req.params.id).get();
        if (!snapshot.empty) {
            await snapshot.docs[0].ref.delete();
        }
        res.status(200).json({ mensagem: 'Radar excluído.' });
    } catch (e) { 
        res.status(500).send(e.message); 
    }
});

// ==========================================
// 🛫 ROTA DE BUSCA DE AEROPORTOS (DUFFEL)
// ==========================================
app.get('/api/aeroportos/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query || query.length < 2) {
            return res.status(200).json([]);
        }
        
        const places = await duffel.suggestions.list({ query: query });
        
        const aeroportos = places.data
            .filter(p => p.iata_code != null)
            .map(p => ({
                iata: p.iata_code,
                nome: p.name,
                cidade: p.city_name || p.name
            }));
        
        res.status(200).json(aeroportos);
    } catch (error) {
        console.error("❌ ERRO AO BUSCAR AEROPORTOS:", error.message);
        res.status(200).json([]); 
    }
});

// ==========================================
// 🏨 ROTA DE BUSCA REAL DE HOTÉIS (RAPIDAPI BOOKING)
// ==========================================
app.get('/api/hoteis/search', async (req, res) => {
    try {
        const query = req.query.q;

        if (!query) {
            return res.status(400).json({ erro: "Digite um destino" });
        }

        console.log(`🔎 Buscando ID de destino no Booking para: ${query}`);

        const optionsDestino = {
            method: 'GET',
            url: 'https://booking-com.p.rapidapi.com/v1/hotels/locations',
            params: { units: 'metric', name: query, locale: 'pt-br' },
            headers: {
                'X-RapidAPI-Key': rapidApiKey,
                'X-RapidAPI-Host': 'booking-com.p.rapidapi.com'
            }
        };

        const responseDestino = await axios.request(optionsDestino);
        
        if (!responseDestino.data || responseDestino.data.length === 0) {
            return res.status(404).json({ erro: "Destino não encontrado" });
        }

        const local = responseDestino.data[0];
        const destId = local.dest_id;
        const destType = local.dest_type;

        console.log(`✅ ID encontrado: ${destId} (${destType}). Buscando hotéis...`);

        const optionsHoteis = {
            method: 'GET',
            url: 'https://booking-com.p.rapidapi.com/v1/hotels/search',
            params: {
                checkin_date: '2026-07-10', 
                dest_type: destType,
                units: 'metric',
                checkout_date: '2026-07-15',
                adults_number: '2',
                order_by: 'popularity',
                dest_id: destId,
                filter_by_currency: 'EUR',
                locale: 'pt-br',
                room_number: '1'
            },
            headers: {
                'X-RapidAPI-Key': rapidApiKey,
                'X-RapidAPI-Host': 'booking-com.p.rapidapi.com'
            }
        };

        const responseHoteis = await axios.request(optionsHoteis);
        const listaBruta = responseHoteis.data.result || [];

        const hoteisFormatados = listaBruta.map(h => {
            const foto = (h.max_photo_url && typeof h.max_photo_url === 'string') ? h.max_photo_url : "https://via.placeholder.com/400x200";
            const idHotel = h.hotel_id ? h.hotel_id.toString() : Math.random().toString();
            
            const precoLimpo = h.min_total_price ? parseFloat(h.min_total_price).toFixed(2) : '';
            const preco = precoLimpo ? `Preço Base de Referência: ${h.currencycode} ${precoLimpo}` : '';
            const qualidade = h.review_score_word ? `${h.review_score_word}` : 'Bom';
            const morada = h.address ? h.address : 'Centro da cidade';

            return {
                id: idHotel,
                name: h.hotel_name || "Hotel sem Nome",
                stars: h.class || 3, 
                rating: h.review_score ? h.review_score.toString() : "8.0",
                description: `Excelente opção em ${query.toUpperCase()}.\n\nEste alojamento está localizado na morada: ${morada} (a aproximadamente ${h.distance_to_cc || '?'}km do centro histórico).\n\n${preco}\n\nCom a garantia de serviço e acompanhamento do Go Driver, ative o seu radar para encontrarmos o melhor preço para as suas datas específicas.`,
                amenities: ["Wi-fi Gratuito", "Garantia Go Driver", qualidade],
                images: [foto]
            };
        });

        res.status(200).json(hoteisFormatados);

    } catch (error) {
        const detalheErro = error.response ? error.response.data : error.message;
        console.error("❌ ERRO DETALHADO NO BOOKING:", detalheErro);
        res.status(500).json({ erro: "Erro ao buscar hotéis reais." });
    }
});

// ==========================================
// 📸 ROTA DE FOTOS DO HOTEL (RAPIDAPI)
// ==========================================
app.get('/api/hoteis/:id/fotos', async (req, res) => {
    try {
        const hotelId = req.params.id;

        const options = {
            method: 'GET',
            url: 'https://booking-com.p.rapidapi.com/v1/hotels/photos',
            params: { hotel_id: hotelId, locale: 'pt-br' },
            headers: {
                'X-RapidAPI-Key': rapidApiKey,
                'X-RapidAPI-Host': 'booking-com.p.rapidapi.com'
            }
        };

        const response = await axios.request(options);
        const fotosBrutas = response.data || [];
        
        const fotos = fotosBrutas.map(f => f.url_max || f.url_1440 || f.url_square60).filter(f => f != null);

        res.status(200).json(fotos.slice(0, 15));
    } catch (error) {
        console.error("❌ ERRO AO BUSCAR FOTOS:", error.message);
        res.status(200).json([]); 
    }
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
      payment_method_options: {
        card: { installments: { enabled: true } } 
      }
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

        res.status(200).json({ sucesso: true, localizador: pnr });
    } catch (error) {
        res.status(500).json({ erro: 'Falha na emissão.', detalhes: error.message });
    }
});

// ==========================================
// 🤖 O NOVO CÉREBRO TRIPLO DO GO DRIVER
// ==========================================
const executarBusca = async () => {
    const snapshot = await radaresColl.where('status', '==', 'buscando').get();
    
    if (snapshot.empty) {
        return; 
    }

    console.log(`\n🔄 CÉREBRO ATIVO: Analisando ${snapshot.size} radares ativos...`);

    for (let doc of snapshot.docs) {
        let radar = doc.data();
        let tipo = radar.tipoRadar || 'voo'; 
        
        const precoAlvo = parseFloat(radar.preco.toString().replace(',', '.'));
        const moedaBase = radar.codigoMoeda || 'EUR';

        let dtCheckin = radar.checkin || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        let dtCheckout = radar.checkout || new Date(Date.now() + 35 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        let dVooSoIda = radar.data !== 'Qualquer Data' && !radar.data.includes('Entre') ? radar.data.split('/').reverse().join('-') : dtCheckin;

        // ---------------------------------------------------------
        // RAMIFICAÇÃO 1: APENAS VOO
        // ---------------------------------------------------------
        if (tipo === 'voo') {
            console.log(`\n🔎 [ROBÔ VOO] ${radar.origem} ➔ ${radar.destino} | Alvo: ${precoAlvo} ${moedaBase}`);
            try {
                const reqVoo = await duffel.offerRequests.create({
                    slices: [{ origin: radar.origem, destination: radar.destino, departure_date: dVooSoIda }],
                    passengers: [{ type: 'adult' }], 
                    cabin_class: 'economy', 
                    return_offers: true
                });

                if (reqVoo.data.offers?.length > 0) {
                    const melhor = reqVoo.data.offers.sort((a, b) => parseFloat(a.total_amount) - parseFloat(b.total_amount))[0];
                    const taxa = await obterTaxaDeCambio(melhor.total_currency, moedaBase);
                    
                    const precoConvertido = parseFloat(melhor.total_amount) * taxa;
                    const precoFinal = Math.round((precoConvertido + 50) * 100) / 100;

                    console.log(`  ✈️ Duffel achou por ${precoFinal} ${moedaBase}`);

                    if (precoFinal <= precoAlvo) {
                        const companhiaAerea = melhor.owner.name;
                        const dataObj = new Date(melhor.slices[0].segments[0].departing_at);
                        const horarioPartida = dataObj.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
                        const linkCompanhia = `https://www.google.com/search?q=check-in+online+${companhiaAerea.replace(/ /g, '+')}`;

                        await doc.ref.update({
                            status: 'encontrado',
                            precoEncontrado: precoFinal,
                            dataVoo: dVooSoIda.split('-').reverse().join('/'),
                            horario: horarioPartida,
                            companhia: companhiaAerea,
                            linkOriginal: linkCompanhia,
                            offerId: melhor.id,
                            passengerId: reqVoo.data.passengers[0].id
                        });
                        console.log(`  🚨 BINGO VOO! Dados atualizados.`);
                    }
                }
            } catch (e) {
                console.error(`  ⚠️ Erro na Duffel:`, e.message);
            }
        }

        // ---------------------------------------------------------
        // RAMIFICAÇÃO 2: APENAS HOTEL
        // ---------------------------------------------------------
        else if (tipo === 'hotel') {
            const cidadeBusca = radar.nomeDestino || radar.destino; 
            console.log(`\n🔎 [ROBÔ HOTEL] Cidade: ${cidadeBusca} | Alvo: ${precoAlvo} ${moedaBase}`);
            try {
                const rLocal = await axios.get('https://booking-com.p.rapidapi.com/v1/hotels/locations', { 
                    params: { name: cidadeBusca, locale: 'pt-br' }, 
                    headers: { 'X-RapidAPI-Key': rapidApiKey, 'X-RapidAPI-Host': 'booking-com.p.rapidapi.com' } 
                });
                
                if (rLocal.data && rLocal.data.length > 0) {
                    const local = rLocal.data[0];
                    const qtdAdultos = radar.adultos ? radar.adultos.toString() : '2';

                    const rHotel = await axios.get('https://booking-com.p.rapidapi.com/v1/hotels/search', {
                        params: { 
                            checkin_date: dtCheckin, 
                            checkout_date: dtCheckout, 
                            dest_type: local.dest_type, 
                            dest_id: local.dest_id, 
                            adults_number: qtdAdultos, 
                            filter_by_currency: moedaBase, 
                            order_by: 'price', 
                            units: 'metric', 
                            locale: 'pt-br' 
                        },
                        headers: { 'X-RapidAPI-Key': rapidApiKey, 'X-RapidAPI-Host': 'booking-com.p.rapidapi.com' }
                    });

                    if (rHotel.data.result?.length > 0) {
                        const hotelBase = rHotel.data.result[0];
                        console.log(`  🏨 Booking achou: ${hotelBase.hotel_name} por ${hotelBase.min_total_price} ${moedaBase}`);
                        
                        if (hotelBase.min_total_price <= precoAlvo) {
                            await doc.ref.update({ 
                                status: 'encontrado', 
                                precoEncontrado: hotelBase.min_total_price, 
                                nomeHotel: hotelBase.hotel_name 
                            });
                            console.log(`  🚨 BINGO HOTEL! Dados salvos.`);
                        }
                    }
                }
            } catch (e) {
                console.error(`  ⚠️ Erro no Booking:`, e.message);
            }
        }

        // ---------------------------------------------------------
        // RAMIFICAÇÃO 3: PACOTE (VOO + HOTEL)
        // ---------------------------------------------------------
        else if (tipo === 'pacote') {
            console.log(`\n🔎 [ROBÔ PACOTE] ${radar.origem} ➔ ${radar.destino} | Alvo Total: ${precoAlvo} ${moedaBase}`);
            try {
                const qtdPassageiros = radar.adultos ? parseInt(radar.adultos) : 2;
                const passageirosArray = Array(qtdPassageiros).fill({ type: 'adult' });

                const reqPacoteVoo = await duffel.offerRequests.create({
                    slices: [
                        { origin: radar.origem, destination: radar.destino, departure_date: dtCheckin },
                        { origin: radar.destino, destination: radar.origem, departure_date: dtCheckout }
                    ],
                    passengers: passageirosArray, 
                    cabin_class: 'economy', 
                    return_offers: true
                });

                if (reqPacoteVoo.data.offers?.length > 0) {
                    const melhorVoo = reqPacoteVoo.data.offers.sort((a, b) => parseFloat(a.total_amount) - parseFloat(b.total_amount))[0];
                    const taxaVoo = await obterTaxaDeCambio(melhorVoo.total_currency, moedaBase);
                    const precoVooConvertido = Math.round((parseFloat(melhorVoo.total_amount) * taxaVoo + 50) * 100) / 100;
                    
                    console.log(`  ✈️ Custo Voo (Ida/Volta): ${precoVooConvertido} ${moedaBase}`);

                    if (precoVooConvertido < precoAlvo) {
                        const cidadeBusca = radar.nomeDestino || radar.destino;
                        
                        const rLoc = await axios.get('https://booking-com.p.rapidapi.com/v1/hotels/locations', { 
                            params: { name: cidadeBusca, locale: 'pt-br' }, 
                            headers: { 'X-RapidAPI-Key': rapidApiKey, 'X-RapidAPI-Host': 'booking-com.p.rapidapi.com' } 
                        });
                        
                        if (rLoc.data && rLoc.data.length > 0) {
                            const local = rLoc.data[0];
                            
                            const rHot = await axios.get('https://booking-com.p.rapidapi.com/v1/hotels/search', {
                                params: { 
                                    checkin_date: dtCheckin, 
                                    checkout_date: dtCheckout, 
                                    dest_type: local.dest_type, 
                                    dest_id: local.dest_id, 
                                    adults_number: qtdPassageiros.toString(), 
                                    filter_by_currency: moedaBase, 
                                    order_by: 'price', 
                                    units: 'metric', 
                                    locale: 'pt-br',
                                    room_number: '1' 
                                },
                                headers: { 'X-RapidAPI-Key': rapidApiKey, 'X-RapidAPI-Host': 'booking-com.p.rapidapi.com' }
                            });

                            if (rHot.data.result?.length > 0) {
                                const hotelBase = rHot.data.result[0];
                                const precoHotelConvertido = hotelBase.min_total_price || 0;
                                const precoTotal = Math.round((precoVooConvertido + precoHotelConvertido) * 100) / 100;
                                
                                console.log(`  🏨 Custo Hotel: ${precoHotelConvertido} | TOTAL DO PACOTE: ${precoTotal} ${moedaBase}`);

                                if (precoTotal <= precoAlvo) {
                                    const companhiaAerea = melhorVoo.owner.name;

                                    await doc.ref.update({
                                        status: 'encontrado', 
                                        precoEncontrado: precoTotal,
                                        precoVooDetalhe: precoVooConvertido, 
                                        precoHotelDetalhe: precoHotelConvertido,
                                        nomeHotel: hotelBase.hotel_name, 
                                        companhia: companhiaAerea,
                                        offerId: melhorVoo.id, 
                                        passengerId: reqPacoteVoo.data.passengers[0].id
                                    });
                                    console.log(`  🚨 BINGO PACOTE! Voo + Hotel couberam no orçamento.`);
                                } else { 
                                    console.log(`  ❌ Preço final (${precoTotal}) acima do alvo (${precoAlvo}).`); 
                                }
                            } else { 
                                console.log(`  📭 Não foi possível encontrar hotéis baratos o suficiente.`); 
                            }
                        }
                    } else { 
                        console.log(`  ❌ O Voo sozinho já esgotou ou ultrapassou o orçamento. Pesquisa de hotel ignorada.`); 
                    }
                } else { 
                    console.log(`  📭 Nenhum voo encontrado para essas datas.`); 
                }
            } catch (e) {
                console.error(`  ⚠️ Erro no Pacote:`, e.message);
            }
        }

        // ---------------------------------------------------------
        // RAMIFICAÇÃO 4: ALUGUER DE CARROS (RENT-A-CAR)
        // ---------------------------------------------------------
        else if (tipo === 'carro') {
            console.log(`\n🔎 [ROBÔ CARRO] Local: ${radar.destino} (${radar.nomeDestino}) | Alvo: ${precoAlvo} ${moedaBase}`);
            try {
                let vClass = 'economy';
                if (radar.categoriaCarro === 'SUV') vClass = 'suv';
                if (radar.categoriaCarro === 'Luxo') vClass = 'premium';
                if (radar.categoriaCarro === 'Van' || radar.categoriaCarro === 'Familiar') vClass = 'minivan';

                let lat = radar.latitude;
                let lng = radar.longitude;

                if (!lat || !lng) {
                    console.log(`  📍 Coordenadas não memorizadas. A gastar 1 chamada...`);
                    const rLocalCarro = await axios.get('https://booking-com.p.rapidapi.com/v1/hotels/locations', { 
                        params: { name: radar.nomeDestino || radar.destino, locale: 'pt-br' }, 
                        headers: { 'X-RapidAPI-Key': rapidApiKey, 'X-RapidAPI-Host': 'booking-com.p.rapidapi.com' } 
                    });
                    
                    if (rLocalCarro.data && rLocalCarro.data.length > 0) {
                        lat = rLocalCarro.data[0].latitude;
                        lng = rLocalCarro.data[0].longitude;
                        await doc.ref.update({ latitude: lat, longitude: lng });
                        console.log(`  💾 Memória Atualizada! Lat: ${lat}, Lng: ${lng}`);
                    }
                }

                if (lat && lng) {
                    const optionsCarro = {
                        method: 'GET',
                        url: 'https://booking-com.p.rapidapi.com/v1/car-rental/search',
                        params: {
                            pick_up_datetime: `${dtCheckin} 10:00`,
                            drop_off_datetime: `${dtCheckout} 10:00`,
                            pick_up_longitude: lng, 
                            pick_up_latitude: lat,  
                            drop_off_longitude: lng, 
                            drop_off_latitude: lat,  
                            sort_by: 'recommended',
                            locale: 'pt-br',
                            currency: moedaBase,
                            from_country: 'es' 
                        },
                        headers: {
                            'X-RapidAPI-Key': rapidApiKey,
                            'X-RapidAPI-Host': 'booking-com.p.rapidapi.com'
                        }
                    };

                    const rCarro = await axios.request(optionsCarro);
                    
                    // O CÉREBRO ADAPTÁVEL: Lê "search_results", "content" ou devolve vazio.
                    const frotaBruta = rCarro.data.search_results || rCarro.data.content || [];
                    
                    const chaves = Object.keys(rCarro.data);
                    console.log(`  🕵️ Estrutura da API: [${chaves.join(', ')}] | Carros detetados: ${frotaBruta.length}`);
                    
                    if (frotaBruta.length > 0) {
                        const carrosDisponiveis = frotaBruta.filter(car => {
                            // Extração com proteção extra contra mudanças da Booking
                            const seats = car.vehicle_info?.seats || car.seats || 5;
                            const vClassApi = car.vehicle_info?.v_class || car.v_class || '';
                            
                            const capacidadeOk = parseInt(seats) >= parseInt(radar.lugares || 5);
                            const classeOk = radar.categoriaCarro === 'Económico' ? true : vClassApi.toLowerCase().includes(vClass);
                            
                            return capacidadeOk && classeOk;
                        }).sort((a, b) => {
                            const precoA = a.pricing_info?.price || a.price || 0;
                            const precoB = b.pricing_info?.price || b.price || 0;
                            return precoA - precoB;
                        });

                        if (carrosDisponiveis.length > 0) {
                            const melhorCarro = carrosDisponiveis[0];
                            
                            // Mapeamento à prova de balas
                            const precoEncontradoCarro = parseFloat(melhorCarro.pricing_info?.price || melhorCarro.price || 0);
                            const nomeCarro = melhorCarro.vehicle_info?.v_name || melhorCarro.name || 'Carro Alugado';
                            const nomeFornecedor = melhorCarro.supplier_info?.name || melhorCarro.supplier || 'Agência Local';
                            const lugaresCarro = melhorCarro.vehicle_info?.seats || melhorCarro.seats || radar.lugares;

                            console.log(`  🚗 Achou: ${nomeCarro} (${nomeFornecedor}) por ${precoEncontradoCarro} ${moedaBase}`);

                            if (precoEncontradoCarro <= precoAlvo) {
                                await doc.ref.update({
                                    status: 'encontrado',
                                    precoEncontrado: precoEncontradoCarro,
                                    companhia: nomeFornecedor,
                                    categoriaCarro: nomeCarro, 
                                    lugares: lugaresCarro,
                                    linkOriginal: 'https://www.rentalcars.com'
                                });
                                console.log(`  🚨 BINGO CARROS! Dados salvos com sucesso.`);
                            } else {
                                console.log(`  ❌ Preço do carro (${precoEncontradoCarro}) acima do alvo (${precoAlvo}).`);
                            }
                        } else {
                            console.log(`  📭 Nenhum carro da categoria ${radar.categoriaCarro} com ${radar.lugares} lugares encontrado.`);
                        }
                    } else {
                        console.log(`  📭 Nenhuma rent-a-car com frota disponível neste local exato.`);
                    }
                } else {
                    console.log(`  ❌ Falha: Não foi possível obter coordenadas para a cidade.`);
                }
            } catch (e) {
                const detalhe = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
                console.error(`  ⚠️ Erro no Motor de Carros:`, detalhe);
            }
        }
        
        await new Promise(r => setTimeout(r, 2000)); 
    }
};

// ==========================================
// 🚀 INICIALIZAÇÃO E TEMPORIZADOR
// ==========================================
const iniciarRobo = () => {
    console.log("\n🤖 Cérebro Triplo do Go Driver (Voo, Hotel, Pacotes, Carros) ONLINE!");
    executarBusca();
    setInterval(executarBusca, 300000); 
};

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Go Driver na nuvem (Porta ${PORT})`);
    iniciarRobo();
});