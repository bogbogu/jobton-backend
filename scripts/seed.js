// One-off seed script: loads the Jobton frontend's mock Jobs/Freelancers
// data (previously hardcoded in the frontend, never persisted anywhere)
// into MongoDB so the database isn't empty once the frontend is wired to
// the real API. Safe to re-run — it skips a collection if it already has
// documents rather than duplicating or wiping data.
//
// Usage: npm run seed

import "dotenv/config";
import mongoose from "mongoose";
import Job from "../src/models/job.model.js";
import Freelancer from "../src/models/freelancer.model.js";
import Company from "../src/models/company.model.js";
import { slugify } from "../src/utils/slugify.utils.js";

// ---------------------------------------------------------------------------
// Source data — transcribed from the frontend's src/hooks/useJobs.ts and
// src/constants/freelancers.ts mock arrays (numeric `id` dropped; Mongo
// assigns real ObjectIds on insert).
// ---------------------------------------------------------------------------

const mockJobs = [
  { company: "Flutterwave", domain: "flutterwave.com", title: "Senior Product Designer", location: "Lagos, Nigeria (Remote)", type: "Full Time", salary: "₦800,000 / month", status: ["verified"], skills: ["UI/UX", "Figma", "Product Strategy"], posted: "2 days ago", applicants: 15, industry: "Fintech", experience: "3–5 years", qualification: "B.Sc / HND", description: "We are looking for a talented Senior Product Designer to join our growing design team. You will work closely with product managers, engineers, and other designers to create intuitive, delightful, and impactful experiences for millions of users.", responsibilities: ["Design user-centered digital products and experiences", "Collaborate with cross-functional teams from ideation to launch", "Create wireframes, prototypes, and high-fidelity designs", "Conduct user research and usability testing", "Maintain and improve our design system"] },
  { company: "Google", domain: "google.com", title: "Product Designer", location: "Lagos, Nigeria", type: "Full Time", salary: "$8,000 / month", status: ["featured", "verified"], skills: ["UI/UX", "Figma", "Research"], posted: "3 days ago", applicants: 30, industry: "Technology", experience: "4–6 years", qualification: "B.Sc", description: "Join Google's product design team and help shape the future of search and beyond. You will work on products used by billions of people worldwide.", responsibilities: ["Lead design for key product areas within Google Search", "Collaborate with cross-functional teams across time zones", "Conduct and synthesise user research", "Produce high-fidelity designs and prototypes"] },
  { company: "Microsoft", domain: "microsoft.com", title: "UI/UX Designer", location: "Abuja, Nigeria", type: "On-site", salary: "₦500,000 / month", status: ["verified"], skills: ["Figma", "Azure", "UX Research"], posted: "3 days ago", applicants: 18, industry: "Technology", experience: "2–4 years", qualification: "B.Sc / HND", description: "Microsoft is hiring a UI/UX Designer to work on enterprise productivity tools. You will collaborate with engineers and PMs to deliver high-quality user experiences across Africa.", responsibilities: ["Design interfaces for Microsoft enterprise products", "Create and maintain the design system", "Partner with PMs and engineers to ship features", "Gather and act on user feedback"] },
  { company: "Meta", domain: "meta.com", title: "Product Designer", location: "Remote", type: "Contract", salary: "$2,000 – $2,500 / month", status: ["verified"], skills: ["React", "Figma", "Motion Design"], posted: "4 days ago", applicants: 42, industry: "Social Media", experience: "3–5 years", qualification: "B.Sc", description: "Meta is seeking a Product Designer to work on next-generation social experiences. You will be part of a fully remote, globally distributed team shaping the future of connection.", responsibilities: ["Design features for Meta's social products", "Work closely with engineers on implementation", "Create prototypes and high-fidelity mockups", "Champion accessibility in all designs"] },
  { company: "Google", domain: "google.com", title: "Senior UX Designer", location: "Remote", type: "Full Time", salary: "₦900,000 / month", status: ["featured"], skills: ["UX Research", "Figma", "Prototyping"], posted: "5 days ago", applicants: 25, industry: "Technology", experience: "5+ years", qualification: "B.Sc", description: "We are looking for a Senior UX Designer to lead the design of Google's developer tools. You will shape the experience for millions of developers globally.", responsibilities: ["Lead UX for developer-facing products", "Define and drive design strategy", "Mentor junior designers on the team", "Champion user research as a core practice"] },
  { company: "Microsoft", domain: "microsoft.com", title: "Product Designer", location: "On-site", type: "Full Time", salary: "₦600,000 / month", status: ["verified"], skills: ["Figma", "Azure DevOps", "Sketch"], posted: "5 days ago", applicants: 10, industry: "Technology", experience: "2–3 years", qualification: "B.Sc / HND", description: "Join the Microsoft Nigeria team as a Product Designer, working on cloud productivity products that power businesses across Africa.", responsibilities: ["Create UX flows and wireframes", "Collaborate with engineers and PMs", "Contribute to the design system", "Present designs to key stakeholders"] },
  { company: "Spotify", domain: "spotify.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$6,500 / month", status: ["featured"], skills: ["Figma", "Design Systems", "Prototyping"], posted: "1 day ago", applicants: 12, industry: "Music Streaming", experience: "3–5 years", qualification: "B.Sc", description: "Join Spotify's product design team to craft engaging experiences for millions of listeners worldwide.", responsibilities: ["Design intuitive user interfaces", "Collaborate with engineers and PMs", "Prototype new features", "Conduct usability testing"] },
  { company: "Netflix", domain: "netflix.com", title: "Senior UI Designer", location: "Remote", type: "Full Time", salary: "$7,800 / month", status: ["verified"], skills: ["UI Design", "Figma", "Interaction Design"], posted: "Today", applicants: 8, industry: "Entertainment", experience: "5+ years", qualification: "B.Sc", description: "Help shape the future of streaming experiences across TV, web, and mobile platforms.", responsibilities: ["Design high-quality interfaces", "Improve design systems", "Work closely with engineering", "Present concepts to stakeholders"] },
  { company: "Airbnb", domain: "airbnb.com", title: "UX Designer", location: "Remote", type: "Full Time", salary: "$6,900 / month", status: ["featured", "verified"], skills: ["Research", "Figma", "User Flows"], posted: "2 days ago", applicants: 20, industry: "Travel", experience: "3–5 years", qualification: "B.Sc", description: "Design seamless booking and hosting experiences used by millions around the globe.", responsibilities: ["Create user journeys", "Conduct research", "Produce prototypes", "Collaborate across teams"] },
  { company: "Paystack", domain: "paystack.com", title: "Product Designer", location: "Lagos, Nigeria", type: "Hybrid", salary: "₦950,000 / month", status: ["verified"], skills: ["Figma", "Design Systems", "UX"], posted: "Today", applicants: 6, industry: "Fintech", experience: "2–4 years", qualification: "B.Sc / HND", description: "Work with the Paystack team to build delightful payment experiences for African businesses.", responsibilities: ["Design new product features", "Collaborate with PMs", "Maintain design system", "Improve onboarding flows"] },
  { company: "Notion", domain: "notion.so", title: "Visual Designer", location: "Remote", type: "Contract", salary: "$5,500 / month", status: ["featured"], skills: ["Brand Design", "Figma", "Illustration"], posted: "3 days ago", applicants: 15, industry: "Productivity", experience: "2–5 years", qualification: "B.Sc", description: "Help evolve Notion's visual language across product and marketing experiences.", responsibilities: ["Create polished UI visuals", "Design marketing assets", "Collaborate with product teams", "Maintain visual consistency"] },
  { company: "Canva", domain: "canva.com", title: "Senior Product Designer", location: "Remote", type: "Full Time", salary: "$7,200 / month", status: ["featured", "verified"], skills: ["Figma", "Design Systems", "UX Research"], posted: "Today", applicants: 11, industry: "Design Software", experience: "4–6 years", qualification: "B.Sc", description: "Join Canva's product team to build intuitive creative tools used by millions of people worldwide.", responsibilities: ["Design end-to-end product experiences", "Prototype and validate ideas", "Collaborate with engineers and PMs", "Improve the design system"] },
  { company: "Adobe", domain: "adobe.com", title: "UX Designer", location: "Remote", type: "Full Time", salary: "$7,800 / month", status: ["verified"], skills: ["Adobe XD", "Figma", "User Research"], posted: "1 day ago", applicants: 17, industry: "Software", experience: "3–5 years", qualification: "B.Sc", description: "Design creative experiences across Adobe's suite of products with a focus on usability and innovation.", responsibilities: ["Create user flows and wireframes", "Conduct user research", "Build interactive prototypes", "Collaborate with engineering teams"] },
  { company: "Stripe", domain: "stripe.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$8,500 / month", status: ["featured"], skills: ["Figma", "Product Thinking", "Design Systems"], posted: "Today", applicants: 9, industry: "Fintech", experience: "4+ years", qualification: "B.Sc", description: "Help build financial infrastructure products that power businesses around the world.", responsibilities: ["Design payment experiences", "Collaborate with cross-functional teams", "Run design reviews", "Improve accessibility"] },
  { company: "Moniepoint", domain: "moniepoint.com", title: "Product Designer", location: "Lagos, Nigeria", type: "Hybrid", salary: "₦1,100,000 / month", status: ["verified"], skills: ["Figma", "UX", "Design Systems"], posted: "2 days ago", applicants: 22, industry: "Fintech", experience: "3–5 years", qualification: "B.Sc / HND", description: "Work on digital banking products that empower businesses across Africa.", responsibilities: ["Design intuitive financial products", "Collaborate with product managers", "Create prototypes", "Maintain component libraries"] },
  { company: "Amazon", domain: "amazon.com", title: "Senior UX Designer", location: "Remote", type: "Full Time", salary: "$9,000 / month", status: ["featured", "verified"], skills: ["UX Research", "Figma", "Prototyping"], posted: "Today", applicants: 19, industry: "E-commerce", experience: "5+ years", qualification: "B.Sc", description: "Shape shopping experiences across Amazon's web and mobile platforms.", responsibilities: ["Lead UX initiatives", "Create high-fidelity designs", "Mentor designers", "Present design solutions"] },
  { company: "Shopify", domain: "shopify.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$7,100 / month", status: ["verified"], skills: ["Figma", "Interaction Design", "UX"], posted: "3 days ago", applicants: 14, industry: "E-commerce", experience: "3–5 years", qualification: "B.Sc", description: "Design tools that help entrepreneurs build and grow online businesses.", responsibilities: ["Design merchant experiences", "Prototype product ideas", "Collaborate with engineers", "Improve design consistency"] },
  { company: "Interswitch", domain: "interswitchgroup.com", title: "UI/UX Designer", location: "Lagos, Nigeria", type: "Full Time", salary: "₦850,000 / month", status: ["verified"], skills: ["Figma", "UX Research", "UI Design"], posted: "1 day ago", applicants: 13, industry: "Fintech", experience: "2–4 years", qualification: "B.Sc / HND", description: "Help create seamless payment and banking experiences for millions of users.", responsibilities: ["Design customer-facing interfaces", "Conduct usability testing", "Collaborate with engineering", "Maintain UI standards"] },
  { company: "Slack", domain: "slack.com", title: "Product Designer", location: "Remote", type: "Contract", salary: "$6,700 / month", status: ["featured"], skills: ["Figma", "Interaction Design", "Design Systems"], posted: "2 days ago", applicants: 18, industry: "Communication", experience: "3–5 years", qualification: "B.Sc", description: "Design collaboration experiences that help teams communicate more effectively.", responsibilities: ["Design collaboration features", "Prototype workflows", "Run usability sessions", "Partner with engineering"] },
  { company: "Duolingo", domain: "duolingo.com", title: "Visual Product Designer", location: "Remote", type: "Full Time", salary: "$6,300 / month", status: ["verified"], skills: ["Visual Design", "Illustration", "Figma"], posted: "Today", applicants: 16, industry: "EdTech", experience: "2–4 years", qualification: "B.Sc", description: "Create delightful learning experiences for millions of language learners.", responsibilities: ["Design engaging interfaces", "Collaborate with researchers", "Prototype new concepts", "Improve visual consistency"] },
  { company: "GitHub", domain: "github.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$8,100 / month", status: ["featured", "verified"], skills: ["Figma", "Developer Tools", "UX"], posted: "Today", applicants: 7, industry: "Developer Tools", experience: "4–6 years", qualification: "B.Sc", description: "Help improve the experience for millions of developers building software together.", responsibilities: ["Design developer workflows", "Conduct user interviews", "Build prototypes", "Collaborate with engineering teams"] },
  { company: "LinkedIn", domain: "linkedin.com", title: "Senior Product Designer", location: "Remote", type: "Full Time", salary: "$8,300 / month", status: ["featured"], skills: ["Figma", "UX Research", "Design Systems"], posted: "Today", applicants: 9, industry: "Professional Networking", experience: "5+ years", qualification: "B.Sc", description: "Design products that help professionals connect, learn, and find opportunities worldwide.", responsibilities: ["Lead product design initiatives", "Conduct user research", "Create prototypes", "Collaborate with product and engineering"] },
  { company: "Uber", domain: "uber.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$7,900 / month", status: ["verified"], skills: ["Figma", "Interaction Design", "UX"], posted: "1 day ago", applicants: 15, industry: "Transportation", experience: "3–5 years", qualification: "B.Sc", description: "Design intuitive experiences for riders, drivers, and merchants across Uber's platform.", responsibilities: ["Design user journeys", "Prototype new concepts", "Partner with engineers", "Validate designs through testing"] },
  { company: "Bolt", domain: "bolt.eu", title: "UI/UX Designer", location: "Lagos, Nigeria", type: "Hybrid", salary: "₦780,000 / month", status: ["verified"], skills: ["Figma", "Wireframing", "User Research"], posted: "Today", applicants: 11, industry: "Mobility", experience: "2–4 years", qualification: "B.Sc / HND", description: "Help build seamless ride-hailing and delivery experiences for African users.", responsibilities: ["Design customer-facing features", "Work with cross-functional teams", "Prototype interfaces", "Maintain design quality"] },
  { company: "Figma", domain: "figma.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$8,900 / month", status: ["featured", "verified"], skills: ["Design Systems", "Prototyping", "UX"], posted: "Today", applicants: 5, industry: "Design Software", experience: "4–6 years", qualification: "B.Sc", description: "Help shape the future of collaborative design tools used by millions worldwide.", responsibilities: ["Design collaborative workflows", "Conduct usability research", "Prototype product ideas", "Work closely with engineers"] },
  { company: "Apple", domain: "apple.com", title: "Interaction Designer", location: "Cupertino, CA", type: "Full Time", salary: "$10,500 / month", status: ["verified"], skills: ["Interaction Design", "SwiftUI", "Figma"], posted: "2 days ago", applicants: 28, industry: "Consumer Electronics", experience: "5+ years", qualification: "B.Sc", description: "Design elegant experiences across Apple's ecosystem of hardware and software.", responsibilities: ["Design product interactions", "Collaborate with engineering", "Present concepts to leadership", "Prototype experiences"] },
  { company: "X", domain: "x.com", title: "Product Designer", location: "Remote", type: "Contract", salary: "$6,800 / month", status: ["featured"], skills: ["Figma", "Motion Design", "UI Design"], posted: "3 days ago", applicants: 24, industry: "Social Media", experience: "3–5 years", qualification: "B.Sc", description: "Design engaging social experiences for users around the world.", responsibilities: ["Design new platform features", "Prototype interactions", "Improve usability", "Collaborate with product teams"] },
  { company: "Oracle", domain: "oracle.com", title: "UX Designer", location: "Remote", type: "Full Time", salary: "$7,400 / month", status: ["verified"], skills: ["Figma", "Enterprise UX", "Research"], posted: "1 day ago", applicants: 12, industry: "Enterprise Software", experience: "4–6 years", qualification: "B.Sc", description: "Help modernize enterprise software experiences across Oracle Cloud.", responsibilities: ["Design enterprise interfaces", "Conduct user research", "Build prototypes", "Partner with product managers"] },
  { company: "Salesforce", domain: "salesforce.com", title: "Senior UX Designer", location: "Remote", type: "Full Time", salary: "$8,100 / month", status: ["featured"], skills: ["UX Strategy", "Figma", "Research"], posted: "Today", applicants: 10, industry: "CRM", experience: "5+ years", qualification: "B.Sc", description: "Design world-class CRM experiences for businesses of every size.", responsibilities: ["Lead UX strategy", "Prototype complex workflows", "Collaborate with engineers", "Mentor junior designers"] },
  { company: "Discord", domain: "discord.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$7,300 / month", status: ["verified"], skills: ["UI Design", "Figma", "Design Systems"], posted: "Today", applicants: 13, industry: "Communication", experience: "3–5 years", qualification: "B.Sc", description: "Create engaging communication experiences for millions of communities worldwide.", responsibilities: ["Design messaging features", "Prototype new ideas", "Improve accessibility", "Collaborate across teams"] },
  { company: "Binance", domain: "binance.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$7,600 / month", status: ["featured", "verified"], skills: ["Figma", "Fintech", "UX"], posted: "2 days ago", applicants: 21, industry: "Blockchain", experience: "3–5 years", qualification: "B.Sc", description: "Design intuitive experiences for global cryptocurrency and financial products.", responsibilities: ["Design trading interfaces", "Conduct user testing", "Create design specifications", "Collaborate with engineering teams"] },
  { company: "GitLab", domain: "gitlab.com", title: "Senior Product Designer", location: "Remote", type: "Full Time", salary: "$8,000 / month", status: ["verified"], skills: ["Design Systems", "Developer Tools", "Figma"], posted: "1 day ago", applicants: 8, industry: "Developer Tools", experience: "4–6 years", qualification: "B.Sc", description: "Join GitLab's all-remote team to build tools that empower software developers.", responsibilities: ["Design end-to-end developer experiences", "Lead UX initiatives", "Prototype features", "Collaborate asynchronously across teams"] },
  { company: "Wise", domain: "wise.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$7,000 / month", status: ["featured"], skills: ["Figma", "Fintech", "User Research"], posted: "Today", applicants: 14, industry: "Financial Services", experience: "3–5 years", qualification: "B.Sc", description: "Design fast, transparent international money transfer experiences for millions of customers.", responsibilities: ["Design customer journeys", "Improve onboarding flows", "Prototype new features", "Collaborate with engineering and research"] },
  { company: "Amazon", domain: "amazon.com", title: "Senior Product Designer", location: "Remote", type: "Full Time", salary: "$7,400 / month", status: ["featured"], skills: ["Figma", "Design Systems", "UX Research"], posted: "Today", applicants: 18, industry: "E-commerce", experience: "4–6 years", qualification: "B.Sc", description: "Design customer experiences across Amazon's shopping ecosystem.", responsibilities: ["Lead end-to-end product design", "Create prototypes", "Partner with engineers", "Improve customer journeys"] },
  { company: "Adobe", domain: "adobe.com", title: "UX Designer", location: "Remote", type: "Full Time", salary: "$6,800 / month", status: ["verified"], skills: ["Adobe XD", "Figma", "Research"], posted: "1 day ago", applicants: 12, industry: "Software", experience: "3–5 years", qualification: "B.Sc", description: "Join Adobe's experience design team building creative tools.", responsibilities: ["Conduct UX research", "Design workflows", "Prototype interfaces", "Work with engineering teams"] },
  { company: "Canva", domain: "canva.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$6,200 / month", status: ["featured", "verified"], skills: ["Figma", "Interaction Design", "UI"], posted: "2 days ago", applicants: 22, industry: "Design Software", experience: "3–5 years", qualification: "B.Sc", description: "Help millions create beautiful designs with Canva.", responsibilities: ["Design new editor features", "Collaborate with PMs", "Improve usability", "Build prototypes"] },
  { company: "Stripe", domain: "stripe.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$8,200 / month", status: ["verified"], skills: ["Figma", "Design Systems", "Fintech"], posted: "Today", applicants: 11, industry: "Fintech", experience: "4+ years", qualification: "B.Sc", description: "Design payment experiences for businesses worldwide.", responsibilities: ["Design payment flows", "Create prototypes", "Conduct user testing", "Collaborate cross-functionally"] },
  { company: "Moniepoint", domain: "moniepoint.com", title: "Senior UX Designer", location: "Lagos, Nigeria", type: "Hybrid", salary: "₦1,100,000 / month", status: ["featured"], skills: ["UX", "Figma", "Research"], posted: "Today", applicants: 9, industry: "Fintech", experience: "5+ years", qualification: "B.Sc / HND", description: "Improve financial experiences for businesses across Africa.", responsibilities: ["Lead UX initiatives", "Conduct research", "Mentor designers", "Improve onboarding flows"] },
  { company: "Interswitch", domain: "interswitchgroup.com", title: "UI Designer", location: "Lagos, Nigeria", type: "Full Time", salary: "₦750,000 / month", status: ["verified"], skills: ["UI Design", "Figma", "Illustrator"], posted: "3 days ago", applicants: 17, industry: "Fintech", experience: "2–4 years", qualification: "B.Sc", description: "Design digital banking experiences for African users.", responsibilities: ["Design interfaces", "Maintain UI consistency", "Collaborate with developers", "Review usability"] },
  { company: "GitHub", domain: "github.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$7,000 / month", status: ["featured"], skills: ["Figma", "Developer Tools", "UX"], posted: "1 day ago", applicants: 14, industry: "Developer Tools", experience: "3–5 years", qualification: "B.Sc", description: "Shape the future of software collaboration.", responsibilities: ["Design developer experiences", "Prototype workflows", "Collaborate with PMs", "Run usability studies"] },
  { company: "Slack", domain: "slack.com", title: "UX Designer", location: "Remote", type: "Full Time", salary: "$6,700 / month", status: ["verified"], skills: ["Research", "UI", "Figma"], posted: "2 days ago", applicants: 16, industry: "Communication", experience: "3+ years", qualification: "B.Sc", description: "Design collaborative workplace experiences.", responsibilities: ["Improve messaging UX", "Prototype features", "Conduct user interviews", "Support design system"] },
  { company: "Dropbox", domain: "dropbox.com", title: "Senior UI Designer", location: "Remote", type: "Full Time", salary: "$6,900 / month", status: ["featured"], skills: ["UI", "Design Systems", "Figma"], posted: "4 days ago", applicants: 20, industry: "Cloud Storage", experience: "5+ years", qualification: "B.Sc", description: "Design productivity tools used by millions.", responsibilities: ["Lead interface design", "Create reusable components", "Collaborate with engineers", "Present design reviews"] },
  { company: "Oracle", domain: "oracle.com", title: "Product Designer", location: "Abuja, Nigeria", type: "Hybrid", salary: "₦850,000 / month", status: ["verified"], skills: ["UX", "Figma", "Enterprise Design"], posted: "Today", applicants: 13, industry: "Enterprise Software", experience: "3–5 years", qualification: "B.Sc", description: "Design enterprise cloud products for business customers.", responsibilities: ["Design enterprise dashboards", "Collaborate with PMs", "Validate concepts", "Improve accessibility"] },
  { company: "Salesforce", domain: "salesforce.com", title: "UX Designer", location: "Remote", type: "Full Time", salary: "$7,300 / month", status: ["featured", "verified"], skills: ["Research", "Figma", "CRM"], posted: "Today", applicants: 7, industry: "CRM", experience: "4–6 years", qualification: "B.Sc", description: "Design customer relationship management experiences.", responsibilities: ["Improve workflows", "Conduct user research", "Prototype solutions", "Work with engineers"] },
  { company: "Asana", domain: "asana.com", title: "Product Designer", location: "Remote", type: "Contract", salary: "$5,900 / month", status: ["verified"], skills: ["Figma", "UX", "Prototyping"], posted: "5 days ago", applicants: 15, industry: "Productivity", experience: "3–5 years", qualification: "B.Sc", description: "Design features that help teams work better together.", responsibilities: ["Design collaboration tools", "Build prototypes", "Conduct research", "Partner with product teams"] },
  { company: "Shopify", domain: "shopify.com", title: "Senior Product Designer", location: "Remote", type: "Full Time", salary: "$7,500 / month", status: ["featured"], skills: ["Commerce", "Figma", "UX"], posted: "2 days ago", applicants: 19, industry: "E-commerce", experience: "5+ years", qualification: "B.Sc", description: "Help merchants succeed with world-class commerce experiences.", responsibilities: ["Lead product design", "Improve merchant tools", "Prototype ideas", "Collaborate with engineering"] },
  { company: "LinkedIn", domain: "linkedin.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$7,100 / month", status: ["verified"], skills: ["Figma", "Research", "Interaction Design"], posted: "Today", applicants: 10, industry: "Professional Networking", experience: "3–5 years", qualification: "B.Sc", description: "Design experiences that connect professionals globally.", responsibilities: ["Design networking features", "Conduct usability testing", "Collaborate cross-functionally", "Create design specs"] },
  { company: "Palantir", domain: "palantir.com", title: "UX Designer", location: "Remote", type: "Full Time", salary: "$8,500 / month", status: ["featured"], skills: ["Enterprise UX", "Figma", "Research"], posted: "3 days ago", applicants: 8, industry: "Data Analytics", experience: "5+ years", qualification: "B.Sc", description: "Design mission-critical software for enterprise customers.", responsibilities: ["Design complex workflows", "Conduct user interviews", "Prototype interfaces", "Support product strategy"] },
  { company: "Bolt", domain: "bolt.eu", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$5,800 / month", status: ["verified"], skills: ["Figma", "Mobility", "UX"], posted: "Yesterday", applicants: 12, industry: "Mobility", experience: "3–5 years", qualification: "B.Sc", description: "Design ride-hailing and mobility experiences.", responsibilities: ["Design mobile features", "Improve booking flow", "Run usability tests", "Collaborate with engineers"] },
  { company: "Duolingo", domain: "duolingo.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$6,400 / month", status: ["featured", "verified"], skills: ["Gamification", "Figma", "UI"], posted: "Today", applicants: 21, industry: "EdTech", experience: "3–5 years", qualification: "B.Sc", description: "Create delightful language-learning experiences.", responsibilities: ["Design engaging lessons", "Prototype new ideas", "Conduct research", "Collaborate with product teams"] },
  { company: "Zoom", domain: "zoom.us", title: "Senior UX Designer", location: "Remote", type: "Full Time", salary: "$7,200 / month", status: ["verified"], skills: ["Figma", "Accessibility", "UX"], posted: "2 days ago", applicants: 11, industry: "Communication", experience: "5+ years", qualification: "B.Sc", description: "Help improve video communication experiences worldwide.", responsibilities: ["Lead UX projects", "Improve meeting workflows", "Create prototypes", "Mentor designers"] },
  { company: "Figma", domain: "figma.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$8,000 / month", status: ["featured"], skills: ["Design Systems", "Figma", "Prototyping"], posted: "Today", applicants: 26, industry: "Design Software", experience: "4–6 years", qualification: "B.Sc", description: "Build the future of collaborative design tools.", responsibilities: ["Design new editor capabilities", "Prototype experiences", "Collaborate with engineers", "Improve design workflows"] },
  { company: "Revolut", domain: "revolut.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$6,900 / month", status: ["verified"], skills: ["Fintech", "UX", "Figma"], posted: "Yesterday", applicants: 14, industry: "Fintech", experience: "3–5 years", qualification: "B.Sc", description: "Design modern financial experiences for global users.", responsibilities: ["Design fintech products", "Validate user flows", "Create mockups", "Work with PMs"] },
  { company: "HubSpot", domain: "hubspot.com", title: "UX Designer", location: "Remote", type: "Full Time", salary: "$6,300 / month", status: ["featured"], skills: ["CRM", "Research", "Figma"], posted: "4 days ago", applicants: 18, industry: "Marketing Software", experience: "3–5 years", qualification: "B.Sc", description: "Design tools that help businesses grow.", responsibilities: ["Design CRM experiences", "Run user testing", "Prototype concepts", "Improve accessibility"] },
  { company: "Andela", domain: "andela.com", title: "Product Designer", location: "Remote", type: "Full Time", salary: "$4,800 / month", status: ["verified"], skills: ["UX", "Figma", "Remote Collaboration"], posted: "Today", applicants: 29, industry: "Talent Marketplace", experience: "2–4 years", qualification: "B.Sc / HND", description: "Design experiences that connect global talent with companies.", responsibilities: ["Improve hiring flows", "Create design assets", "Collaborate with product", "Conduct research"] },
  { company: "Opay", domain: "opayweb.com", title: "UI/UX Designer", location: "Lagos, Nigeria", type: "Full Time", salary: "₦850,000 / month", status: ["featured", "verified"], skills: ["Figma", "UI", "UX"], posted: "Today", applicants: 24, industry: "Fintech", experience: "3–5 years", qualification: "B.Sc / HND", description: "Design secure and intuitive financial products for millions of users.", responsibilities: ["Design mobile banking features", "Create prototypes", "Conduct UX research", "Collaborate with engineering"] },
];

const mockFreelancers = [
  { name: "Adaeze Okonkwo", role: "Frontend Developer", category: "Development", location: "Lagos, NG", availability: "Available now", hourlyRate: "$32/hr", yearsExperience: 5, projectsCompleted: 46, rating: 4.9, bio: "Builds performant, conversion-focused web interfaces for startups and growth teams.", skills: ["React", "TypeScript", "Tailwind", "Vite"], email: "adaeze.okonkwo@jobton.dev", phone: "+2348103019001", handles: [{ platform: "LinkedIn", href: "https://linkedin.com" }, { platform: "Portfolio", href: "https://example.com/adaeze" }, { platform: "X", href: "https://x.com" }] },
  { name: "Tunde Balogun", role: "UI/UX Designer", category: "Design", location: "Abuja, NG", availability: "Available next week", hourlyRate: "$28/hr", yearsExperience: 6, projectsCompleted: 52, rating: 4.8, bio: "Designs clean product experiences with strong usability and visual clarity.", skills: ["Figma", "Design Systems", "Prototyping", "User Research"], email: "tunde.balogun@jobton.dev", phone: "+2348117741200", handles: [{ platform: "Portfolio", href: "https://example.com/tunde" }, { platform: "Instagram", href: "https://instagram.com" }] },
  { name: "Fatima Yusuf", role: "Content Strategist", category: "Marketing", location: "Kano, NG", availability: "Available now", hourlyRate: "$24/hr", yearsExperience: 4, projectsCompleted: 39, rating: 4.7, bio: "Creates content funnels and editorial plans that drive qualified leads.", skills: ["SEO", "Copywriting", "Content Strategy", "Analytics"], email: "fatima.yusuf@jobton.dev", phone: "+2348129093414", handles: [{ platform: "LinkedIn", href: "https://linkedin.com" }, { platform: "X", href: "https://x.com" }] },
  { name: "Ifeanyi Nnamdi", role: "Backend Engineer", category: "Development", location: "Port Harcourt, NG", availability: "Limited availability", hourlyRate: "$35/hr", yearsExperience: 7, projectsCompleted: 61, rating: 4.9, bio: "Builds resilient APIs and scalable systems for fintech and SaaS products.", skills: ["Node.js", "PostgreSQL", "Redis", "System Design"], email: "ifeanyi.nnamdi@jobton.dev", phone: "+2348142215092", handles: [{ platform: "Portfolio", href: "https://example.com/ifeanyi" }, { platform: "LinkedIn", href: "https://linkedin.com" }] },
  { name: "Mariam Bello", role: "Virtual Assistant", category: "Operations", location: "Kaduna, NG", availability: "Available now", hourlyRate: "$18/hr", yearsExperience: 3, projectsCompleted: 33, rating: 4.6, bio: "Supports founders with admin workflows, scheduling, and customer communication.", skills: ["Calendar Management", "Notion", "Email Support", "CRM"], email: "mariam.bello@jobton.dev", phone: "+2348167801288", handles: [{ platform: "WhatsApp", href: "https://wa.me/2348167801288" }, { platform: "LinkedIn", href: "https://linkedin.com" }] },
  { name: "Kelechi Umeh", role: "Data Analyst", category: "Data", location: "Enugu, NG", availability: "Available next week", hourlyRate: "$29/hr", yearsExperience: 5, projectsCompleted: 41, rating: 4.8, bio: "Turns raw product and business data into actionable dashboards and insights.", skills: ["SQL", "Power BI", "Python", "A/B Testing"], email: "kelechi.umeh@jobton.dev", phone: "+2348134400719", handles: [{ platform: "LinkedIn", href: "https://linkedin.com" }, { platform: "Portfolio", href: "https://example.com/kelechi" }] },
  { name: "Sade Akin", role: "Social Media Manager", category: "Marketing", location: "Ibadan, NG", availability: "Available now", hourlyRate: "$22/hr", yearsExperience: 4, projectsCompleted: 48, rating: 4.7, bio: "Plans and executes social campaigns that improve engagement and brand recall.", skills: ["Content Planning", "Meta Ads", "Community", "Canva"], email: "sade.akin@jobton.dev", phone: "+2348172299180", handles: [{ platform: "Instagram", href: "https://instagram.com" }, { platform: "X", href: "https://x.com" }] },
  { name: "Chinedu Eze", role: "Mobile Developer", category: "Development", location: "Owerri, NG", availability: "Limited availability", hourlyRate: "$34/hr", yearsExperience: 6, projectsCompleted: 44, rating: 4.8, bio: "Delivers cross-platform mobile apps with polished UX and stable releases.", skills: ["React Native", "Expo", "Firebase", "App Store Release"], email: "chinedu.eze@jobton.dev", phone: "+2348185203366", handles: [{ platform: "Portfolio", href: "https://example.com/chinedu" }, { platform: "LinkedIn", href: "https://linkedin.com" }] },
];

// ---------------------------------------------------------------------------
// Transforms — map the old frontend mock shape onto the real Mongoose schema.
// ---------------------------------------------------------------------------

// All 56 mock jobs are design roles ("Product Designer", "UX Designer", ...)
// — this is honest to the source data, not a simplification.
const CATEGORY = "Design";

// The mock `type` field conflated employment type ("Full Time", "Contract")
// with work arrangement ("On-site", "Hybrid") — the schema now models these
// as two separate fields (`employmentType` and `workArrangement`), so
// nothing from the source data is lost. `type` only ever signals true
// employment type via "Full Time"/"Contract"; "On-site"/"Hybrid" signal
// arrangement instead (handled by resolveWorkArrangementAndLocation below).
const resolveEmploymentType = (type) => (type === "Contract" ? "Contract" : "Full Time");

// Work arrangement in the mock data is signaled three different ways:
//   1. `type: "On-site" | "Hybrid"` (explicit, e.g. Microsoft/Paystack jobs)
//   2. `location: "Remote"` used as the entire location value (very common)
//   3. `location: "<city> (Remote)"` — a real city with a "(Remote)" suffix
//      (e.g. Flutterwave's "Lagos, Nigeria (Remote)") — split apart so the
//      city isn't lost and doesn't stay duplicated inside free text.
// One entry (Microsoft, "Product Designer") has `location: "On-site"`
// verbatim with no real city at all (`type: "Full Time"`) — a quirk already
// present in the source mock, not introduced here; treated the same as
// case 2/3 rather than invented a fake city for it.
const REMOTE_SUFFIX_PATTERN = /\s*\(remote\)\s*$/i;

const resolveWorkArrangementAndLocation = (mock) => {
  const location = mock.location.trim();

  if (/^remote$/i.test(location)) return { workArrangement: "Remote", location };
  if (/^on-site$/i.test(location)) return { workArrangement: "On-site", location };
  if (/^hybrid$/i.test(location)) return { workArrangement: "Hybrid", location };

  if (REMOTE_SUFFIX_PATTERN.test(location)) {
    return { workArrangement: "Remote", location: location.replace(REMOTE_SUFFIX_PATTERN, "").trim() };
  }

  if (mock.type === "On-site") return { workArrangement: "On-site", location };
  if (mock.type === "Hybrid") return { workArrangement: "Hybrid", location };

  return { workArrangement: null, location };
};

const parseSalary = (raw) => {
  const currency = raw.includes("₦") ? "NGN" : "USD";
  const periodMatch = raw.match(/\/\s*(hour|month|year)/i);
  const period = periodMatch ? periodMatch[1].toLowerCase() : "month";
  const numeric = raw.replace(/[₦$,]/g, "");
  const [minPart, maxPart] = numeric.split("–");
  const salaryMin = parseFloat(minPart);
  const salaryMax = maxPart ? parseFloat(maxPart) : null;

  return { salaryMin, salaryMax, salaryCurrency: currency, salaryPeriod: period };
};

const DAY_MS = 24 * 60 * 60 * 1000;

const resolveCreatedAt = (posted) => {
  const now = Date.now();
  if (posted === "Today") return new Date(now);
  if (posted === "Yesterday") return new Date(now - DAY_MS);
  const match = posted.match(/^(\d+)\s+days?\s+ago$/i);
  if (match) return new Date(now - Number(match[1]) * DAY_MS);
  return new Date(now);
};

const transformJob = (mock) => {
  const { workArrangement, location } = resolveWorkArrangementAndLocation(mock);

  return {
    title: mock.title,
    company: mock.company,
    domain: mock.domain,
    logoUrl: "",
    location,
    employmentType: resolveEmploymentType(mock.type),
    workArrangement,
    ...parseSalary(mock.salary),
    category: CATEGORY,
    status: mock.status,
    skills: mock.skills,
    industry: mock.industry,
    experience: mock.experience,
    qualification: mock.qualification,
    description: mock.description,
    responsibilities: mock.responsibilities,
    // Not present in the source mock data — synthesized as a placeholder
    // external application link, not a real job-board URL.
    applicationLink: `https://${mock.domain}/careers`,
    applicants: mock.applicants,
    postedBy: null,
    // Seeded jobs are trusted content, so they skip the review queue.
    reviewStatus: "published",
    createdAt: resolveCreatedAt(mock.posted),
  };
};

const transformFreelancer = (mock) => ({
  ...mock,
  user: null,
});

// One Company per distinct company name in the mock job data, so the
// company pages have real content to show. Company is only loosely coupled
// to Job (matched by name string, not a foreign key — see company.model.js
// and job.controller.js's `company` filter), so this doesn't require any
// change to how jobs themselves are stored.
const deriveCompanies = (jobs) => {
  const byName = new Map();

  for (const mock of jobs) {
    if (!byName.has(mock.company)) {
      byName.set(mock.company, {
        name: mock.company,
        // Set explicitly rather than relying on the pre('save') slug hook —
        // insertMany() doesn't run per-document save middleware.
        slug: slugify(mock.company),
        domain: mock.domain,
        industry: mock.industry,
        createdBy: null,
      });
    }
  }

  return [...byName.values()];
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const seed = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB.");

  const existingJobCount = await Job.countDocuments();
  if (existingJobCount > 0) {
    console.log(`Skipped jobs — ${existingJobCount} already in the database.`);
  } else {
    const inserted = await Job.insertMany(mockJobs.map(transformJob));
    console.log(`Seeded ${inserted.length} jobs.`);
  }

  const existingFreelancerCount = await Freelancer.countDocuments();
  if (existingFreelancerCount > 0) {
    console.log(`Skipped freelancers — ${existingFreelancerCount} already in the database.`);
  } else {
    const inserted = await Freelancer.insertMany(mockFreelancers.map(transformFreelancer));
    console.log(`Seeded ${inserted.length} freelancers.`);
  }

  const existingCompanyCount = await Company.countDocuments();
  if (existingCompanyCount > 0) {
    console.log(`Skipped companies — ${existingCompanyCount} already in the database.`);
  } else {
    const inserted = await Company.insertMany(deriveCompanies(mockJobs));
    console.log(`Seeded ${inserted.length} companies.`);
  }

  await mongoose.disconnect();
  console.log("Done.");
};

seed().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
