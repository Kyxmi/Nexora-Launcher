'use strict';

// Relie le launcher à ton projet Supabase.
// Les deux valeurs se trouvent dans Supabase > Project Settings > API Keys
// (l'adresse du projet est aussi affichée par le bouton « Connect » en haut du tableau de bord).
//
// La clé « publishable » (sb_publishable_…) peut être livrée dans le launcher sans danger :
// ce sont les règles de supabase/schema.sql qui protègent les données.
// Ne mets JAMAIS ici la clé « secret » (sb_secret_…) ni l'ancienne clé « service_role ».

module.exports = {
  supabaseUrl: process.env.NEXORA_SUPABASE_URL || 'https://nizcckodixxbuxxelwre.supabase.co',
  supabaseKey: process.env.NEXORA_SUPABASE_KEY || 'sb_publishable_MF2ReX6UB1q9H7yEsQck_A_lqMk-Ix1',

  // Taille maximale d'un .exe : 50 Mo sur l'offre gratuite de Supabase.
  // Si tu passes à l'offre Pro, augmente aussi la limite dans Supabase > Storage > Settings.
  maxUploadMb: Number(process.env.NEXORA_MAX_UPLOAD_MB) || 50,
};
