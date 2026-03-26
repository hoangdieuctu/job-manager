'use strict';

const db = require('./database');

// --- Jobs ---

const jobs = [
  {
    title: 'Senior Backend Engineer',
    company: 'Acme Corp',

    status: 'open',
    description: `We are looking for a Senior Backend Engineer to join our platform team. You will own the design and delivery of scalable services that power our e-commerce platform serving 5M+ users.

Responsibilities:
- Design and build high-throughput REST and gRPC APIs
- Lead technical design discussions and mentor junior engineers
- Drive reliability improvements (SLOs, on-call, runbooks)
- Collaborate with product and frontend teams on new features`,
    requirements: `- 5+ years of backend engineering experience
- Strong proficiency in Node.js or Go
- Experience with PostgreSQL or similar relational databases
- Familiarity with Kubernetes and cloud platforms (AWS/GCP)
- Track record of shipping production-grade services
- Excellent communication skills`,
  },
  {
    title: 'Frontend Engineer (React)',
    company: 'Bright Labs',

    status: 'screening',
    description: `Bright Labs is hiring a Frontend Engineer to build delightful, accessible user interfaces for our SaaS analytics product used by 500+ enterprise customers.

Responsibilities:
- Implement pixel-perfect UIs from Figma designs
- Build reusable component library with Storybook
- Optimise performance (Core Web Vitals, bundle size)
- Write unit and integration tests`,
    requirements: `- 3+ years React experience
- TypeScript proficiency
- Familiarity with state management (Redux, Zustand, or similar)
- Experience with testing libraries (Jest, Testing Library)
- Eye for design and attention to detail
- Experience with CI/CD pipelines`,
  },
  {
    title: 'Machine Learning Engineer',
    company: 'DataSphere AI',

    status: 'open',
    description: `DataSphere AI is looking for an ML Engineer to productionise our recommendation and NLP models. You will bridge research and production, ensuring models run efficiently at scale.

Responsibilities:
- Deploy and monitor ML models in production (serving latency < 100ms p99)
- Build feature pipelines with Apache Spark or dbt
- Collaborate with data scientists to bring prototypes to production
- Instrument models for drift detection and A/B testing`,
    requirements: `- 3+ years ML engineering experience
- Python expertise (PyTorch or TensorFlow)
- Experience with MLflow, Kubeflow, or similar ML platforms
- Strong software engineering fundamentals
- Familiarity with vector databases (Pinecone, Weaviate) is a plus`,
  },
];

// --- CV text blocks ---

const cvs = {
  'Senior Backend Engineer': [
    {
      name: 'Lena Hoffmann',
      email: 'lena.hoffmann@email.com',
      text: `Lena Hoffmann
lena.hoffmann@email.com | +49 176 123 4567 | Berlin, Germany
github.com/lenahoffmann | linkedin.com/in/lenahoffmann

SUMMARY
Backend engineer with 7 years of experience building distributed systems in Go and Node.js. Passionate about reliability engineering and developer tooling.

EXPERIENCE

Senior Software Engineer — Zalando SE, Berlin (2021–present)
- Owned the order management microservice handling 80k RPM during peak sales
- Reduced p99 latency by 40% through query optimisation and connection pooling
- Led migration from REST to gRPC for internal service communication
- Mentored 3 junior engineers; introduced structured on-call runbooks

Backend Engineer — HelloFresh, Berlin (2018–2021)
- Built the recipe recommendation API serving 2M weekly active users
- Introduced PostgreSQL read replicas, cutting reporting query times by 70%
- Participated in weekly on-call rotation across 12-member team

Junior Developer — Freelance (2017–2018)
- Developed REST APIs for 4 client projects using Node.js and MongoDB

SKILLS
Go, Node.js, PostgreSQL, Redis, Kubernetes, AWS (ECS/RDS/SQS), gRPC, Terraform, Prometheus/Grafana

EDUCATION
B.Sc. Computer Science — TU Berlin, 2017`,
    },
    {
      name: 'Marcus Webb',
      email: 'marcus.webb@protonmail.com',
      text: `Marcus Webb
marcus.webb@protonmail.com | London → Berlin (relocation ready)
github.com/mwebb-dev

SUMMARY
6 years backend experience across fintech and logistics. Enjoy hard distributed systems problems and building internal platforms that help other engineers ship faster.

EXPERIENCE

Staff Engineer — Monzo Bank, London (2022–present)
- Tech lead for the Payments Core team (5 engineers)
- Designed idempotent payment processing pipeline processing £2B/month
- Championed adoption of structured logging; reduced MTTR by 30%

Backend Engineer — Deliveroo, London (2019–2022)
- Rebuilt the rider dispatch service in Go (previously Ruby); 3× throughput improvement
- Introduced contract testing with Pact across 8 microservices

Software Developer — Thoughtworks, London (2018–2019)
- Delivered full-stack features for a UK retail client using Node.js / React

SKILLS
Go, Node.js (TypeScript), PostgreSQL, Kafka, Kubernetes (GKE), Terraform, Datadog, Pact

EDUCATION
MEng Computer Science — University of Bristol, 2018`,
    },
    {
      name: 'Priya Nair',
      email: 'priya.nair@outlook.com',
      text: `Priya Nair
priya.nair@outlook.com | Bangalore (open to Berlin relocation)

SUMMARY
Backend developer with 4 years in Node.js. Looking to grow into a senior role at a product company. Strong in API design and SQL performance tuning.

EXPERIENCE

Software Engineer — Flipkart, Bangalore (2021–present)
- Built seller onboarding APIs serving 50k merchants
- Optimised slow queries, reducing dashboard load time from 8s to 1.2s
- Wrote ADRs and contributed to internal engineering wiki

Junior Software Engineer — TCS, Pune (2020–2021)
- Maintained legacy Java services and assisted migration to Node.js

SKILLS
Node.js, Express, PostgreSQL, MySQL, Docker, AWS (EC2, Lambda), Jest

EDUCATION
B.E. Information Technology — VIT University, 2020

NOTE
Currently at 4 years total experience. Aware this role targets 5+; confident I can ramp quickly given the team structure.`,
    },
  ],

  'Frontend Engineer (React)': [
    {
      name: 'Sophie Andersen',
      email: 'sophie.andersen@gmail.com',
      text: `Sophie Andersen
sophie.andersen@gmail.com | Copenhagen (Remote)
portfolio: sophieandersen.dev

SUMMARY
Frontend engineer with 5 years specialising in React and design systems. Care deeply about accessibility and performance. Fluent in Danish and English.

EXPERIENCE

Senior Frontend Engineer — Pleo, Copenhagen (2022–present)
- Built Pleo's design system (40+ components) with React + TypeScript + Storybook
- Reduced bundle size by 35% through code-splitting and lazy loading
- Achieved WCAG 2.1 AA compliance across core product flows
- Mentored 2 mid-level engineers

Frontend Engineer — Trustpilot, Copenhagen (2020–2022)
- Rebuilt the review submission flow; increased completion rate by 18%
- Introduced React Testing Library; coverage grew from 12% to 68%

Junior Developer — Nodes Agency, Copenhagen (2019–2020)
- Built marketing sites and e-commerce UIs with React and Next.js

SKILLS
React, TypeScript, Next.js, Zustand, Storybook, Vite, Tailwind CSS, Jest, Playwright, Figma

EDUCATION
B.Sc. Computer Science — IT University of Copenhagen, 2019`,
    },
    {
      name: 'Tomasz Kowalski',
      email: 't.kowalski.dev@gmail.com',
      text: `Tomasz Kowalski
t.kowalski.dev@gmail.com | Warsaw (Remote Europe)
github.com/tkowalski

SUMMARY
Experienced React developer focused on performance and developer experience. 6 years building SaaS products, most recently in the HR-tech space.

EXPERIENCE

Lead Frontend Engineer — HiBob, Warsaw (2021–present)
- Led frontend architecture for the onboarding module (React, TypeScript, Redux Toolkit)
- Cut First Contentful Paint from 3.8s to 1.1s through SSR adoption (Next.js)
- Defined frontend coding standards and PR review guidelines

Frontend Engineer — Brainly, Kraków (2018–2021)
- Migrated core pages from AngularJS to React; zero downtime
- Introduced Cypress E2E test suite covering critical user paths

Junior Frontend Developer — Software House XYZ, Warsaw (2017–2018)
- Built UI components for 3 client projects using React and SASS

SKILLS
React, TypeScript, Next.js, Redux Toolkit, React Query, Cypress, Jest, Tailwind CSS, GraphQL, Figma

EDUCATION
B.Sc. Software Engineering — Warsaw University of Technology, 2017`,
    },
  ],

  'Machine Learning Engineer': [
    {
      name: 'Aiko Tanaka',
      email: 'aiko.tanaka@ml-engineer.io',
      text: `Aiko Tanaka
aiko.tanaka@ml-engineer.io | Tokyo → London (visa: BN(O))
github.com/aiko-ml

SUMMARY
ML Engineer with 5 years turning research prototypes into reliable production systems. Focus area: NLP and recommendation engines. Open-source contributor to HuggingFace Transformers.

EXPERIENCE

ML Engineer — Mercari, Tokyo (2021–present)
- Productionised a BERT-based item categorisation model (95% accuracy, <80ms p99)
- Built Airflow + Spark feature pipelines processing 10M events/day
- Deployed models via Seldon Core on Kubernetes; integrated MLflow for experiment tracking
- Introduced shadow mode A/B testing framework adopted by 3 other teams

Data Scientist → ML Engineer — Recruit Holdings, Tokyo (2019–2021)
- Transitioned from notebooks to production; deployed 4 ranking models
- Reduced model retraining costs 50% by switching from full retrain to incremental updates

SKILLS
Python, PyTorch, HuggingFace Transformers, MLflow, Airflow, Apache Spark, Kubernetes, Seldon, Pinecone, SQL

EDUCATION
M.Sc. Computer Science (Machine Learning) — University of Tokyo, 2019`,
    },
    {
      name: 'Rohan Desai',
      email: 'rohan.desai@datascientist.com',
      text: `Rohan Desai
rohan.desai@datascientist.com | Mumbai / London

SUMMARY
Data scientist with 3 years experience building ML models. Strong in Python and statistical modelling. Looking to grow ML engineering skills in a production-focused team.

EXPERIENCE

Data Scientist — Razorpay, Mumbai (2022–present)
- Built fraud detection model (XGBoost) with 92% precision, reducing chargebacks by 20%
- Developed ETL pipelines in Python/pandas; deployed models as Flask APIs
- Conducted A/B tests for pricing feature experiments

Junior Data Analyst — Infosys, Pune (2021–2022)
- Created dashboards in Tableau; wrote SQL queries for business reporting

SKILLS
Python, scikit-learn, XGBoost, PyTorch (learning), pandas, SQL, Flask, Docker, MLflow (basic)

EDUCATION
B.Tech Computer Engineering — IIT Bombay, 2021

NOTE
Limited MLOps experience but actively upskilling (completing Kubeflow course). Excited by the opportunity to work alongside experienced ML engineers.`,
    },
    {
      name: 'Clara Müller',
      email: 'clara.mueller@research.de',
      text: `Clara Müller
clara.mueller@research.de | Munich (open to London)

SUMMARY
Research engineer with 4 years in NLP at a university lab and 1 year in industry. Published 3 papers on question-answering systems. Ready to fully transition to production ML.

EXPERIENCE

Research Engineer — Ludwig Maximilian University, Munich (2020–2024)
- Fine-tuned LLMs for domain-specific QA; improved F1 by 12 points on BioASQ benchmark
- Built evaluation harnesses and data pipelines in Python
- Co-authored 3 peer-reviewed papers (ACL, EMNLP)

ML Engineer (contract) — Aleph Alpha, Heidelberg (2024)
- Integrated retrieval-augmented generation (RAG) pipeline into enterprise product
- Used Weaviate as vector store; reduced hallucination rate by 35% in user testing

SKILLS
Python, PyTorch, HuggingFace, LangChain, Weaviate, dbt (basic), Docker, Git, LaTeX

EDUCATION
M.Sc. Computational Linguistics — LMU Munich, 2020
B.Sc. Mathematics — University of Freiburg, 2018`,
    },
  ],
};

// --- Seed ---

console.log('Seeding database...\n');

for (const jobData of jobs) {
  const job = db.createJob(jobData);
  console.log(`Created job #${job.id}: ${job.title} @ ${job.company}`);

  const candidates = cvs[job.title] || [];
  for (const cv of candidates) {
    const candidate = db.createCandidate({
      job_id: job.id,
      name: cv.name,
      email: cv.email,
      cv_filename: null,
      cv_original_name: null,
      cv_text: cv.text,
    });
    console.log(`  + Candidate #${candidate.id}: ${candidate.name}`);
  }
}

console.log('\nDone.');
