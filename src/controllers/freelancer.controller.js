import mongoose from "mongoose";
import Freelancer from "../models/freelancer.model.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const serializeFreelancer = (freelancer) => ({
  id: freelancer._id.toString(),
  name: freelancer.name,
  role: freelancer.role,
  category: freelancer.category,
  location: freelancer.location,
  availability: freelancer.availability,
  hourlyRate: freelancer.hourlyRate,
  yearsExperience: freelancer.yearsExperience,
  projectsCompleted: freelancer.projectsCompleted,
  rating: freelancer.rating,
  bio: freelancer.bio,
  skills: freelancer.skills,
  email: freelancer.email,
  phone: freelancer.phone,
  handles: freelancer.handles.map((handle) => ({
    platform: handle.platform,
    href: handle.href,
  })),
});

const buildFreelancerFilter = (query) => {
  const filter = {};
  const { q, category } = query;

  if (category && category !== "All") {
    filter.category = category;
  }

  if (q) {
    const pattern = new RegExp(escapeRegExp(String(q).trim()), "i");
    filter.$or = [{ name: pattern }, { role: pattern }, { location: pattern }, { skills: pattern }];
  }

  return filter;
};

const parsePagination = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.limit, 10) || DEFAULT_PAGE_SIZE));
  return { page, limit };
};

export const getFreelancers = async (req, res) => {
  try {
    const filter = buildFreelancerFilter(req.query);
    const { page, limit } = parsePagination(req.query);

    const [freelancers, total] = await Promise.all([
      Freelancer.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Freelancer.countDocuments(filter),
    ]);

    return res.status(200).json({
      message: "Freelancers retrieved successfully.",
      freelancers: freelancers.map(serializeFreelancer),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 0,
      },
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Failed to fetch freelancers.",
    });
  }
};

export const getFreelancerById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: "Freelancer not found." });
    }

    const freelancer = await Freelancer.findById(id);

    if (!freelancer) {
      return res.status(404).json({ message: "Freelancer not found." });
    }

    return res.status(200).json({
      message: "Freelancer retrieved successfully.",
      freelancer: serializeFreelancer(freelancer),
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Failed to fetch freelancer.",
    });
  }
};

export const createFreelancer = async (req, res) => {
  try {
    const {
      name,
      role,
      category,
      location,
      availability,
      hourlyRate,
      yearsExperience,
      projectsCompleted,
      rating,
      bio,
      skills,
      email,
      phone,
      handles,
    } = req.body || {};

    if (
      !name ||
      !role ||
      !category ||
      !location ||
      !hourlyRate ||
      yearsExperience === undefined ||
      !bio ||
      !email ||
      !phone
    ) {
      return res.status(400).json({
        message:
          "name, role, category, location, hourlyRate, yearsExperience, bio, email, and phone are required.",
      });
    }

    const freelancer = await Freelancer.create({
      name,
      role,
      category,
      location,
      availability,
      hourlyRate,
      yearsExperience,
      projectsCompleted,
      rating,
      bio,
      skills,
      email,
      phone,
      handles,
      user: req.user._id,
    });

    return res.status(201).json({
      message: "Freelancer profile created successfully.",
      freelancer: serializeFreelancer(freelancer),
    });
  } catch (error) {
    console.error(error);

    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }

    return res.status(500).json({
      message: "Failed to create freelancer profile.",
    });
  }
};

const UPDATABLE_FREELANCER_FIELDS = [
  "name",
  "role",
  "category",
  "location",
  "availability",
  "hourlyRate",
  "yearsExperience",
  "projectsCompleted",
  "rating",
  "bio",
  "skills",
  "email",
  "phone",
  "handles",
];

export const updateFreelancer = async (req, res) => {
  try {
    const freelancer = req.freelancer;

    for (const field of UPDATABLE_FREELANCER_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
        freelancer[field] = req.body[field];
      }
    }

    await freelancer.save();

    return res.status(200).json({
      message: "Freelancer profile updated successfully.",
      freelancer: serializeFreelancer(freelancer),
    });
  } catch (error) {
    console.error(error);

    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }

    return res.status(500).json({
      message: "Failed to update freelancer profile.",
    });
  }
};

export const deleteFreelancer = async (req, res) => {
  try {
    await req.freelancer.deleteOne();

    return res.status(200).json({
      message: "Freelancer profile deleted successfully.",
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Failed to delete freelancer profile.",
    });
  }
};
