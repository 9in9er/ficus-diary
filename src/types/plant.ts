type Plant = {
    name: string;
    photo: string;
    acquiredAt: string;
    wateringLog: string[];
    notes: Note[];
    userId: string;
    createdAt: string;
    pinned: boolean;
    hidden: boolean;
    deletedAt: string | null;
}