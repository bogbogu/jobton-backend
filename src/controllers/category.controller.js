import Job from "../models/job.model.js";
import { PUBLIC_JOB_FILTER } from "../utils/jobVisibility.js";

export const getCategories = async (req, res) => {
  try {
    const categories = await Job.aggregate([
      {
        $match: {
          category: { $exists: true, $ne: null },
          ...PUBLIC_JOB_FILTER,
        },
      },
      {
        $group: {
          _id: "$category",
          jobCount: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          title: "$_id",
          jobCount: 1,
        },
      },
      {
        $sort: {
          jobCount: -1,
        },
      },
    ]);

    return res.status(200).json({
      message: "Categories retrieved successfully.",
      categories,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: "Failed to fetch categories.",
    });
  }
};
